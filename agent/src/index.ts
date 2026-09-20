import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { migrate } from "./memory/migrate.js";
import { closeDb, db } from "./memory/db.js";
import { spentToday } from "./memory/store.js";
import { connectMcpServers, disconnectMcpServers, mcpStatus } from "./mcp/registry.js";
import { findMission, MISSIONS } from "./missions/index.js";
import { buildAndDeliverReport } from "./missions/report.js";
import { launch, startScheduler, withLock } from "./scheduler.js";
import { runSwarm } from "./swarm/coordinator.js";
import { sandboxExec } from "./tools/sandbox.js";

/**
 * Point d'entrée du démon. Ordre : config → migrations → MCP → sandbox check →
 * scheduler → API HTTP locale.
 *
 * API (127.0.0.1 uniquement, Bearer ORCHESTRATOR_TOKEN) — consommée par Jarvis :
 *   GET  /healthz
 *   GET  /missions                 liste + prochaine exécution
 *   POST /missions/:name           lance une mission (async, 202)
 *   POST /swarm  {objective}       lance un essaim (async, 202) → GET /swarm/:id
 *   GET  /reports/latest           dernier rapport du matin (markdown)
 */

const swarms = new Map<string, { status: "running" | "done" | "failed"; objective: string; result?: unknown; error?: string; startedAt: string }>();

function authorized(req: IncomingMessage): boolean {
  const token = config().ORCHESTRATOR_TOKEN;
  if (!token) return false;
  const h = req.headers.authorization ?? "";
  const given = Buffer.from(h.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse, jobs: ReturnType<typeof startScheduler>): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    const spent = await spentToday().catch(() => -1);
    return json(res, spent < 0 ? 500 : 200, { ok: spent >= 0, spentTodayUsd: spent, mcp: mcpStatus(), jobs: jobs.map((j) => ({ pattern: j.getPattern(), next: j.nextRun() })) });
  }
  if (!authorized(req)) return json(res, 401, { error: "Bearer ORCHESTRATOR_TOKEN requis" });

  if (req.method === "GET" && url.pathname === "/missions") {
    return json(res, 200, MISSIONS.map((m) => ({ name: m.name, cron: m.cron, model: m.model, budgetUsd: m.budgetUsd })));
  }
  const mission = url.pathname.match(/^\/missions\/([a-z_]+)$/);
  if (req.method === "POST" && mission) {
    const m = findMission(mission[1]!);
    if (!m) return json(res, 404, { error: "mission inconnue" });
    void launch(m).catch((e) => logger.error({ err: String(e) }, "mission HTTP"));
    return json(res, 202, { started: m.name });
  }
  if (req.method === "POST" && url.pathname === "/report") {
    void withLock("report", buildAndDeliverReport).catch((e) => logger.error({ err: String(e) }, "report HTTP"));
    return json(res, 202, { started: "report" });
  }
  if (req.method === "POST" && url.pathname === "/swarm") {
    const body = await readJson(req);
    const objective = typeof body.objective === "string" ? body.objective.trim() : "";
    if (objective.length < 10) return json(res, 400, { error: "objective (≥10 caractères) requis" });
    const id = `sw_${Date.now().toString(36)}`;
    swarms.set(id, { status: "running", objective, startedAt: new Date().toISOString() });
    void runSwarm(objective, { budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : undefined })
      .then((r) => swarms.set(id, { ...swarms.get(id)!, status: "done", result: { merged: r.merged, totalUsd: r.totalUsd, wallSeconds: r.wallSeconds, subtasks: r.results.map((x) => ({ id: x.id, role: x.role, status: x.status, seconds: Math.round(x.seconds), usd: x.usage.usd })) } }))
      .catch((e) => swarms.set(id, { ...swarms.get(id)!, status: "failed", error: String(e) }));
    return json(res, 202, { id });
  }
  const sw = url.pathname.match(/^\/swarm\/(sw_[a-z0-9]+)$/);
  if (req.method === "GET" && sw) {
    const s = swarms.get(sw[1]!);
    return s ? json(res, 200, s) : json(res, 404, { error: "inconnu" });
  }
  if (req.method === "GET" && url.pathname === "/reports/latest") {
    const r = await db().query<{ day: string; markdown: string }>(`SELECT day, markdown FROM reports ORDER BY day DESC LIMIT 1`);
    return r.rows[0] ? json(res, 200, r.rows[0]) : json(res, 404, { error: "aucun rapport" });
  }
  json(res, 404, { error: "route inconnue" });
}

async function main(): Promise<void> {
  const cfg = config();
  logger.info({ tz: cfg.TZ, provider: cfg.LLM_PROVIDER, planner: cfg.MODEL_PLANNER, worker: cfg.MODEL_WORKER, pool: cfg.SANDBOX_POOL || "(défaut)" }, "boot");

  await migrate();
  await connectMcpServers();

  const probe = await sandboxExec("node -v && git --version", { timeoutMs: 20_000 });
  if (probe.code !== 0) logger.error({ probe }, "sandbox injoignable — les missions code échoueront");
  else logger.info({ sandbox: probe.stdout.trim().replace(/\n/g, " ") }, "sandbox OK");
  if (!cfg.ORCHESTRATOR_TOKEN) logger.warn("ORCHESTRATOR_TOKEN absent : API HTTP désactivée (sauf /healthz)");

  const jobs = startScheduler();

  const server = createServer((req, res) => {
    handle(req, res, jobs).catch((err) => {
      logger.error({ err: String(err) }, "http");
      json(res, 500, { error: "erreur interne" });
    });
  });
  server.listen(cfg.HEALTH_PORT, "0.0.0.0", () => logger.info({ port: cfg.HEALTH_PORT }, "api"));

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "arrêt");
    for (const j of jobs) j.stop();
    server.close();
    await disconnectMcpServers();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err: String(err) }, "boot échoué");
  process.exit(1);
});
