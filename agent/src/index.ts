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
import { createAgent, getAgent, listAgents, deleteAgent, agentSpend } from "./agents/store.js";
import { createTask, listTasks, unblockTask } from "./agents/tasks.js";
import { startRuntime, stopRuntime } from "./agents/runtime.js";
import { timeline } from "./events.js";
import { homePage, privacyPage, termsPage, vaultPage } from "./pages.js";
import { consumeVaultTicket, createVaultTicket, forgetCredential, listCredentials, putCredential, vaultEnabled } from "./vault.js";
import { proxyScreen, proxyScreenSocket, SCREEN_ENTRY } from "./screen.js";

const PUBLIC_PAGES: Record<string, () => string> = {
  "/": homePage,
  "/privacy": privacyPage,
  "/terms": termsPage,
};

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

/**
 * Authentification de la page /vault par cookie.
 *
 * Un formulaire HTML ne peut pas porter d'en-tête `Authorization` : le
 * contrôle Bearer du reste de l'API ne s'applique donc pas ici. On entre
 * avec un billet à usage unique (`?t=`), échangé contre un cookie
 * HttpOnly + SameSite=Strict, et la redirection nettoie la barre d'adresse.
 * Le jeton de l'API, lui, ne circule jamais dans une URL : une adresse qui
 * contient un secret finit recopiée quelque part.
 */
function vaultCookieOk(req: IncomingMessage): boolean {
  const token = config().ORCHESTRATOR_TOKEN;
  if (!token) return false;
  const raw = /(?:^|;\s*)manzi_vault=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  if (!raw) return false;
  const given = Buffer.from(decodeURIComponent(raw));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * L'écran du navigateur du serveur.
 *
 * Même porte que le coffre : un billet à usage unique, échangé contre un
 * cookie. Le billet arrive par WhatsApp quand l'agent demande un coup de
 * main, ou se génère à la main avec `deploy/vault-link.sh`.
 */
async function screenRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = config().ORCHESTRATOR_TOKEN;
  const ticket = url.searchParams.get("t");
  if (ticket) {
    if (!token) return void json(res, 503, { error: "ORCHESTRATOR_TOKEN absent" });
    if (!(await consumeVaultTicket(ticket).catch(() => false))) {
      logger.warn({ ip: req.socket.remoteAddress }, "billet d'écran invalide ou déjà utilisé");
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      return void res.end("<!doctype html><meta charset=utf-8><p style=\"font:16px system-ui;padding:2rem\">Ce lien a déjà servi ou a expiré. Demande-en un autre au bot, ou lance <code>bash deploy/vault-link.sh</code>.");
    }
    const https = (req.headers["x-forwarded-proto"] ?? "").toString().includes("https") || (config().PUBLIC_URL ?? "").startsWith("https");
    res.writeHead(302, {
      location: SCREEN_ENTRY,
      "set-cookie": `manzi_vault=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${https ? "; Secure" : ""}`,
    });
    return void res.end();
  }
  if (!vaultCookieOk(req)) {
    logger.warn({ ip: req.socket.remoteAddress, path: url.pathname }, "accès refusé à l'écran");
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    return void res.end("<!doctype html><meta charset=utf-8><p style=\"font:16px system-ui;padding:2rem\">Accès refusé. Ouvre le lien que le bot t'a envoyé, ou génère-en un : <code>bash deploy/vault-link.sh</code>.");
  }
  if (url.pathname === "/screen") {
    res.writeHead(302, { location: SCREEN_ENTRY });
    return void res.end();
  }
  return proxyScreen(req, res, url);
}

async function vaultRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = config().ORCHESTRATOR_TOKEN;
  const html = (body: string, code = 200): void => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(body);
  };

  // Entrée par billet à usage unique, jamais par le jeton de l'API. Un
  // jeton dans une URL finit recopié quelque part ; un billet recopié est
  // déjà mort. Il s'obtient sur le serveur : `node dist/cli.js vault-link`.
  const ticket = url.searchParams.get("t");
  if (ticket) {
    if (!token) return html("<!doctype html><meta charset=utf-8><p>ORCHESTRATOR_TOKEN n'est pas configuré : la page du coffre est désactivée.", 503);
    if (!(await consumeVaultTicket(ticket).catch(() => false))) {
      logger.warn({ ip: req.socket.remoteAddress }, "billet de coffre invalide ou déjà utilisé");
      return html("<!doctype html><meta charset=utf-8><title>Coffre</title><p style=\"font:16px system-ui;padding:2rem\">Ce lien a déjà servi ou a expiré. Génère-en un autre :<br><code>ssh manzi@… 'cd manzi-junior &amp;&amp; bash deploy/vault-link.sh'</code>", 401);
    }
    // `Secure` seulement derrière HTTPS : en le posant toujours, le cookie
    // serait rejeté lors d'un test en local sur 127.0.0.1 et la page
    // demanderait le billet en boucle sans jamais dire pourquoi.
    const https = (req.headers["x-forwarded-proto"] ?? "").toString().includes("https") || (config().PUBLIC_URL ?? "").startsWith("https");
    res.writeHead(302, {
      location: "/vault",
      "set-cookie": `manzi_vault=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${https ? "; Secure" : ""}`,
    });
    return void res.end();
  }

  if (!vaultCookieOk(req)) {
    logger.warn({ ip: req.socket.remoteAddress }, "accès refusé au coffre");
    return html("<!doctype html><meta charset=utf-8><title>Coffre</title><p style=\"font:16px system-ui;padding:2rem\">Accès refusé. Génère un lien à usage unique sur le serveur :<br><code>ssh manzi@… 'cd manzi-junior &amp;&amp; bash deploy/vault-link.sh'</code>", 401);
  }

  let notice = "";
  if (req.method === "POST") {
    const form = new URLSearchParams((await readRawBody(req)).toString("utf8"));
    const get = (k: string): string => (form.get(k) ?? "").trim();
    try {
      if (get("op") === "delete") {
        notice = (await forgetCredential(get("site"))) ? `${get("site")} supprimé.` : `${get("site")} n'était pas enregistré.`;
      } else {
        const saved = await putCredential({ site: get("site"), login: get("login"), secret: form.get("secret") ?? "", totp: get("totp") || undefined, url: get("url") || undefined, note: get("note") });
        notice = `${saved.site} enregistré pour ${saved.login}${saved.has_totp ? " (double authentification incluse)" : ""}.`;
      }
    } catch (e) {
      notice = `Refusé : ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // La liste ne peut pas se lire si VAULT_KEY manque — elle n'en a pas besoin
  // (rien n'est déchiffré ici), mais le dire évite une page blanche.
  const entries = await listCredentials().catch(() => []);
  return html(vaultPage(entries, notice, vaultEnabled()));
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

  // Pages publiques exigées par Google pour publier l'écran de consentement
  // OAuth. Servies ici, sur l'adresse qui porte déjà le webhook : le domaine
  // et le tunnel existent, il n'y a rien de plus à héberger, et une politique
  // de confidentialité qui vit à côté du code ne décrit pas une version
  // d'il y a six mois. Volontairement sans authentification — Google doit
  // pouvoir les lire, et elles ne disent rien de privé.
  if (req.method === "GET" && PUBLIC_PAGES[url.pathname]) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
    return void res.end(PUBLIC_PAGES[url.pathname]!());
  }
  // Coffre d'identifiants. Sa propre authentification, avant le contrôle
  // Bearer : un navigateur ne sait pas envoyer d'en-tête Authorization sur
  // un formulaire. Le jeton passe UNE fois en ?k=, est échangé contre un
  // cookie, et la redirection le retire immédiatement de la barre d'adresse.
  if (url.pathname === "/vault") return vaultRoute(req, res, url);
  if (url.pathname === "/screen" || url.pathname.startsWith("/screen/")) return screenRoute(req, res, url);

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
  // --- Agents (section 48) ------------------------------------------------
  // Un segment d'URL peut contenir n'importe quoi : on décode, et l'identité
  // est validée par le store avant toute écriture.
  const agentPath = /^\/agents\/([^/]+)(?:\/(tasks|timeline|unblock))?$/.exec(url.pathname);

  if (url.pathname === "/agents") {
    if (req.method === "GET") return json(res, 200, await listAgents({ includeEphemeral: url.searchParams.get("all") === "1" }));
    if (req.method === "POST") {
      const b = await body();
      if (typeof b.id !== "string" || typeof b.name !== "string") return json(res, 400, { error: "id et name requis" });
      try {
        return json(res, 200, await createAgent(b as never));
      } catch (e) {
        return json(res, 400, { error: String(e instanceof Error ? e.message : e) });
      }
    }
    return json(res, 405, {});
  }

  if (agentPath) {
    const id = decodeURIComponent(agentPath[1]!);
    const sub = agentPath[2];
    const agent = await getAgent(id);
    if (!agent) return json(res, 404, { error: `agent ${id} inconnu` });

    if (!sub && req.method === "GET") return json(res, 200, { ...agent, spend24h: await agentSpend(id) });
    if (!sub && req.method === "DELETE") return json(res, 200, { deleted: await deleteAgent(id) });
    if (sub === "timeline" && req.method === "GET") return json(res, 200, await timeline(id, Number(url.searchParams.get("limit") ?? 50)));
    if (sub === "tasks" && req.method === "GET") return json(res, 200, await listTasks(id));
    if (sub === "tasks" && req.method === "POST") {
      const b = await body();
      const title = typeof b.title === "string" ? b.title.trim() : "";
      if (!title) return json(res, 400, { error: "title requis" });
      return json(res, 200, await createTask({
        agentId: id,
        title,
        brief: typeof b.brief === "string" ? b.brief : "",
        mission: typeof b.mission === "string" ? b.mission : undefined,
        priority: typeof b.priority === "number" ? b.priority : undefined,
        dependsOn: Array.isArray(b.depends_on) ? (b.depends_on as number[]) : undefined,
      }));
    }
    if (sub === "unblock" && req.method === "POST") {
      const b = await body();
      if (typeof b.task_id !== "number") return json(res, 400, { error: "task_id requis" });
      await unblockTask(b.task_id);
      return json(res, 200, { unblocked: b.task_id });
    }
    return json(res, 405, {});
  }

  if (req.method === "GET" && url.pathname === "/tasks") {
    const st = url.searchParams.get("status");
    return json(res, 200, await listTasks(undefined, st ? (st.split(",") as never) : undefined));
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

  // APRÈS migrate : la reprise des tâches orphelines écrit dans des tables
  // qui doivent exister. AVANT le scheduler : une routine qui déclenche une
  // tâche doit trouver une file déjà vidée de ses orphelines.
  await startRuntime();
  await startScheduler();
  if (cfg.HEARTBEAT_ALERTS) startHeartbeat();

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err: String(err) }, "http");
      if (!res.headersSent) json(res, 500, { error: "erreur interne" });
    });
  });
  // Le flux d'image de noVNC est une WebSocket : elle ne passe pas par le
  // gestionnaire HTTP. Sans ce branchement, la page s'affiche, reste noire,
  // et n'explique rien.
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/screen") || !vaultCookieOk(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return void socket.destroy();
    }
    proxyScreenSocket(req, socket, head);
  });
  server.listen(cfg.HEALTH_PORT, "0.0.0.0", () => logger.info({ port: cfg.HEALTH_PORT }, "api"));

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "arrêt");
    stopScheduler();
  stopRuntime();
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
