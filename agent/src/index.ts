import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { migrate } from "./memory/migrate.js";
import { closeDb, db } from "./memory/db.js";
import { spentToday } from "./memory/store.js";
import { connectMcpServers, disconnectMcpServers, mcpStatus } from "./mcp/registry.js";
import { resolveMission, MISSIONS } from "./missions/index.js";
import { listCustomMissions } from "./missions/custom.js";
import { buildAndDeliverReport } from "./missions/report.js";
import { launch, startScheduler, stopScheduler, scheduledJobs, withLock, listSchedules } from "./scheduler.js";
import { runSwarm } from "./swarm/coordinator.js";
import { sandboxExec } from "./tools/sandbox.js";
import { handleChat } from "./channels/chat.js";
import { deliverWhatsApp, primaryNumber, allowedNumbers, markRead, parseMetaWebhook, parseTwilioWebhook, readRawBody, sendWhatsApp, verifyMetaSignature, verifyTwilioSignature, whatsappEnabled } from "./channels/whatsapp.js";
import { mediaToText } from "./channels/media.js";

/**
 * Point d'entrée du démon. Ordre : config → migrations → MCP → sandbox check →
 * scheduler (mode manual : rien sans ordre) → API HTTP.
 *
 * API (Bearer ORCHESTRATOR_TOKEN, sauf /healthz et le webhook WhatsApp signé) :
 *   GET  /healthz
 *   POST /chat {peer, text}          conversation (Jarvis, curl) — mêmes outils que WhatsApp
 *   GET  /missions · POST /missions/:name · POST /report
 *   POST /swarm {objective} · GET /swarm/:id
 *   GET  /reports/latest · GET /schedules
 *   GET|POST /whatsapp/webhook       Meta Cloud API ou Twilio (signature vérifiée, liste blanche)
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

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/* --- WhatsApp ---------------------------------------------------------------- */

async function whatsappWebhook(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const cfg = config();
  if (!whatsappEnabled()) return json(res, 404, { error: "WhatsApp désactivé" });

  if (req.method === "GET" && cfg.WHATSAPP_PROVIDER === "meta") {
    // Vérification du webhook par Meta.
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === cfg.WHATSAPP_VERIFY_TOKEN) {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(url.searchParams.get("hub.challenge") ?? "");
    }
    return json(res, 403, { error: "verify token invalide" });
  }
  if (req.method !== "POST") return json(res, 405, {});

  const raw = await readRawBody(req);
  let inbound;
  if (cfg.WHATSAPP_PROVIDER === "meta") {
    if (!verifyMetaSignature(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
      logger.warn("webhook meta : signature invalide");
      return json(res, 401, {});
    }
    inbound = parseMetaWebhook(JSON.parse(raw.toString("utf8") || "{}"));
  } else {
    const params = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
    const publicUrl = (cfg.PUBLIC_URL ?? "").replace(/\/$/, "") + url.pathname;
    if (!verifyTwilioSignature(publicUrl, params, req.headers["x-twilio-signature"] as string | undefined)) {
      logger.warn("webhook twilio : signature invalide (PUBLIC_URL correct ?)");
      return json(res, 401, {});
    }
    inbound = parseTwilioWebhook(params);
  }
  // Répondre 200 tout de suite : Meta/Twilio réessaient sinon, et le raisonnement prend des secondes.
  res.writeHead(200, { "content-type": cfg.WHATSAPP_PROVIDER === "twilio" ? "text/xml" : "application/json" });
  res.end(cfg.WHATSAPP_PROVIDER === "twilio" ? "<Response></Response>" : "{}");

  const allowed = allowedNumbers();
  for (const m of inbound) {
    if (!allowed.has(m.from)) {
      logger.warn({ from: m.from }, "whatsapp : numéro non autorisé, ignoré");
      continue;
    }
    void markRead(m.id);
    // Une pièce jointe est d'abord lue par un modèle qui voit, puis transmise
    // au chat en texte — le modèle de conversation peut rester textuel.
    const prepared = m.media
      ? mediaToText(m.media).then((t) => [t, m.text && m.text !== m.media?.caption ? m.text : ""].filter(Boolean).join("\n\n"))
      : Promise.resolve(m.text);
    void prepared
      .then((text) => handleChat({ channel: "whatsapp", peer: m.from, text, extId: m.id }))
      .then((reply) => (reply ? sendWhatsApp(m.from, reply) : undefined))
      .catch((e) => logger.error({ err: String(e) }, "whatsapp chat"));
  }
}

/* --- API ----------------------------------------------------------------------- */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/whatsapp/webhook") return whatsappWebhook(req, res, url);
  if (req.method === "GET" && url.pathname === "/healthz") {
    const spent = await spentToday().catch(() => -1);
    return json(res, spent < 0 ? 500 : 200, { ok: spent >= 0, mode: config().AUTONOMY_MODE, spentTodayUsd: spent, mcp: mcpStatus(), whatsapp: config().WHATSAPP_PROVIDER, jobs: scheduledJobs() });
  }
  if (!authorized(req)) return json(res, 401, { error: "Bearer ORCHESTRATOR_TOKEN requis" });

  const body = async () => JSON.parse((await readRawBody(req)).toString("utf8") || "{}") as Record<string, unknown>;

  if (req.method === "POST" && url.pathname === "/chat") {
    const b = await body();
    const text = typeof b.text === "string" ? b.text : "";
    const peer = typeof b.peer === "string" && b.peer ? b.peer : "api";
    if (!text.trim()) return json(res, 400, { error: "text requis" });
    return json(res, 200, { reply: await handleChat({ channel: "api", peer, text }) });
  }
  if (req.method === "GET" && url.pathname === "/missions") {
    const custom = await listCustomMissions();
    return json(res, 200, [
      ...MISSIONS.map((m) => ({ name: m.name, defaultCron: m.cron, model: m.model, budgetUsd: m.budgetUsd, source: "intégrée" })),
      ...custom.map((m) => ({ name: m.name, defaultCron: "", model: m.model, budgetUsd: m.budget_usd, source: `créée par ${m.created_by}` })),
    ]);
  }
  if (req.method === "GET" && url.pathname === "/schedules") return json(res, 200, { mode: config().AUTONOMY_MODE, schedules: await listSchedules(), jobs: scheduledJobs() });
  const mission = url.pathname.match(/^\/missions\/([a-z0-9_]+)$/);
  if (req.method === "POST" && mission) {
    const m = await resolveMission(mission[1]!);
    if (!m) return json(res, 404, { error: "mission inconnue" });
    void launch(m).catch((e) => logger.error({ err: String(e) }, "mission HTTP"));
    return json(res, 202, { started: m.name });
  }
  if (req.method === "POST" && url.pathname === "/report") {
    void withLock("report", buildAndDeliverReport).catch((e) => logger.error({ err: String(e) }, "report HTTP"));
    return json(res, 202, { started: "report" });
  }
  if (req.method === "POST" && url.pathname === "/swarm") {
    const b = await body();
    const objective = typeof b.objective === "string" ? b.objective.trim() : "";
    if (objective.length < 10) return json(res, 400, { error: "objective (≥10 caractères) requis" });
    const id = `sw_${Date.now().toString(36)}`;
    swarms.set(id, { status: "running", objective, startedAt: new Date().toISOString() });
    void runSwarm(objective, { budgetUsd: typeof b.budgetUsd === "number" ? b.budgetUsd : undefined })
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
  // La longueur du jeton, jamais sa valeur : un 401 sur l'API locale vient presque
  // toujours d'un jeton absent (0) ou porteur d'un caractère invisible — un \r de
  // fin de ligne Windows. Sans ce chiffre au démarrage, le diagnostic se fait à
  // l'aveugle, et l'erreur « jeton requis » ne dit pas que le jeton est là mais faux.
  logger.info(
    {
      tz: cfg.TZ,
      mode: cfg.AUTONOMY_MODE,
      provider: cfg.LLM_PROVIDER,
      critical: cfg.LLM_PROVIDER_CRITICAL ?? cfg.LLM_PROVIDER,
      whatsapp: cfg.WHATSAPP_PROVIDER,
      pool: cfg.SANDBOX_POOL || "(défaut)",
      apiTokenLen: cfg.ORCHESTRATOR_TOKEN?.length ?? 0,
      apiTokenClean: /^[A-Za-z0-9_-]*$/.test(cfg.ORCHESTRATOR_TOKEN ?? ""),
    },
    "boot",
  );

  await migrate();
  await connectMcpServers();

  const probe = await sandboxExec("node -v && git --version", { timeoutMs: 20_000 });
  if (probe.code !== 0) logger.error({ probe }, "sandbox injoignable — les missions code échoueront");
  else logger.info({ sandbox: probe.stdout.trim().replace(/\n/g, " ") }, "sandbox OK");
  if (!cfg.ORCHESTRATOR_TOKEN) logger.warn("ORCHESTRATOR_TOKEN absent : API HTTP désactivée (sauf /healthz et webhook)");

  await startScheduler();
  if (cfg.HEARTBEAT_ALERTS) startHeartbeat();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err: String(err) }, "http");
      if (!res.headersSent) json(res, 500, { error: "erreur interne" });
    });
  });
  server.listen(cfg.HEALTH_PORT, "0.0.0.0", () => logger.info({ port: cfg.HEALTH_PORT }, "api"));

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "arrêt");
    stopScheduler();
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

/**
 * Heartbeat : toutes les heures, vérifie DB + sandbox. Alerte UNE fois quand ça casse,
 * une fois quand ça revient. Ce n'est pas une mission (aucun LLM, aucune action) : un état de santé.
 */
function startHeartbeat(): void {
  let down = false;
  const check = async () => {
    let problem = "";
    try {
      await db().query("SELECT 1");
    } catch (e) {
      problem = `Postgres injoignable (${String(e).slice(0, 120)})`;
    }
    if (!problem) {
      const p = await sandboxExec("true", { timeoutMs: 15_000 });
      if (p.code !== 0) problem = `sandbox injoignable (${p.stderr.slice(0, 120)})`;
    }
    if (problem && !down) {
      down = true;
      logger.error({ problem }, "heartbeat: panne");
      const msg = `⚠️ Manzi Junior : ${problem}. Les missions échoueront jusqu'à réparation (docker compose ps / logs).`;
      const to = primaryNumber();
      if (to) await deliverWhatsApp(to, msg).catch(() => false);
      const { sendTelegram } = await import("./tools/notify.js");
      await sendTelegram(msg).catch(() => false);
    } else if (!problem && down) {
      down = false;
      const to = primaryNumber();
      if (to) await deliverWhatsApp(to, "✅ Manzi Junior : de retour en service.").catch(() => false);
    }
  };
  setInterval(() => void check().catch((e) => logger.error({ err: String(e) }, "heartbeat")), 60 * 60_000).unref();
}
