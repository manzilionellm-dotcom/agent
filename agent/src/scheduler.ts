import { Cron } from "croner";
import { config } from "./config.js";
import { dailyBudget } from "./providers.js";
import { outilsIndisponibles } from "./agents/runtime.js";
import { logger } from "./logger.js";
import { db } from "./memory/db.js";
import { spentToday } from "./memory/store.js";
import { MISSIONS, findMission, resolveMission, runMission, type Mission } from "./missions/index.js";
import { buildAndDeliverReport } from "./missions/report.js";

/**
 * Scheduler in-process (croner) + verrou Postgres (advisory lock).
 *
 * Deux modes (AUTONOMY_MODE) :
 *   manual    (défaut) — aucune cron par défaut. Seul le planning ORDONNÉ par l'opérateur
 *              (table `schedules`, rempli via WhatsApp/Jarvis « planifie la veille à 5h »)
 *              s'exécute. Rien d'autre ne tourne sans ordre. Pas de règle cachée.
 *   scheduled — les crons par défaut des missions + le planning ordonné.
 *
 * Invariants : une mission ne tourne jamais deux fois en parallèle ; le plafond
 * journalier est vérifié AVANT de lancer ; une mission qui plante ne tue pas le process.
 */

const REPORT_CRON = "30 7 * * *";
const jobs = new Map<string, Cron>();

function lockKey(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const client = await db().connect();
  try {
    const r = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [lockKey(name)]);
    if (!r.rows[0]?.ok) {
      logger.warn({ name }, "déjà en cours ailleurs — tick ignoré");
      return undefined;
    }
    try {
      return await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [lockKey(name)]);
    }
  } finally {
    client.release();
  }
}

/** En dessous, une mission ne peut même pas finir un tour : autant ne pas partir. */
const MARGE_MIN_USD = 0.2;

export async function launch(m: Mission, opts: { brief?: string } = {}) {
  const cfg = config();
  const spent = await spentToday();
  const plafond = await dailyBudget();
  // Le plafond se vérifiait AVANT le départ, puis la mission gardait SON
  // budget (jusqu'à 5 $) : avec 0,30 $ de marge, elle en dépensait 5. C'est
  // ainsi qu'un plafond de 2,50 $ est devenu 6,50 $ le 24 septembre. Le
  // budget d'une mission est désormais borné par ce qui reste dans la journée.
  const reste = plafond - spent;
  if (reste < MARGE_MIN_USD) {
    logger.error({ spent, cap: plafond, mission: m.name }, "plafond journalier atteint — mission non lancée");
    return undefined;
  }
  // Une mission qui a besoin de GitHub ne part pas si le jeton est mort :
  // elle tournerait, paierait, et rendrait « accès refusé » (2,10 $ pour rien
  // sur iptv_comparator le même jour).
  if (m.mcpServers.includes("github")) {
    const err = await outilsIndisponibles("code");
    if (err) {
      logger.error({ mission: m.name, err }, "mission non lancée : GitHub inutilisable");
      return undefined;
    }
  }
  const borne = { ...m, budgetUsd: Math.min(m.budgetUsd, reste) };
  if (borne.budgetUsd < m.budgetUsd) logger.warn({ mission: m.name, budget: m.budgetUsd, reste: reste.toFixed(2) }, "budget de mission réduit au reste de la journée");
  const first = await withLock(m.name, () => runMission(borne, { brief: opts.brief }));
  // Un seul retry, uniquement sur erreur transitoire (réseau, 429/5xx), après 3 minutes.
  // La consigne est rejouée à l'identique : une reprise qui perd l'ordre du jour
  // referait la mission par défaut, ce qui est pire que ne rien refaire.
  if (first && first.status === "failed" && /ECONN|ETIMEDOUT|429|5\d\d|rate limit|overloaded|socket hang up/i.test(first.text.slice(-2000))) {
    logger.warn({ mission: m.name }, "échec transitoire — nouvelle tentative dans 3 min");
    await new Promise((r) => setTimeout(r, 3 * 60_000));
    const encore = (await dailyBudget()) - (await spentToday());
    if (encore < MARGE_MIN_USD) return first;
    return withLock(m.name, () => runMission({ ...m, budgetUsd: Math.min(m.budgetUsd, encore) }, { brief: opts.brief }));
  }
  return first;
}

function runByName(name: string): () => Promise<void> {
  return async () => {
    if (name === "report") {
      await withLock("report", buildAndDeliverReport);
      return;
    }
    const m = await resolveMission(name);
    if (m) await launch(m);
  };
}

function addJob(name: string, cron: string, source: string): void {
  jobs.get(name)?.stop();
  const tz = config().TZ;
  const job = new Cron(cron, { timezone: tz, protect: true, catch: (e) => logger.error({ err: String(e), mission: name }, "cron erreur") }, runByName(name));
  jobs.set(name, job);
  logger.info({ mission: name, pattern: cron, next: job.nextRun()?.toISOString(), source }, "cron planifiée");
}

/* --- Planning ordonné (table schedules) ------------------------------------ */

export async function listSchedules(): Promise<Array<{ mission: string; cron: string; created_by: string; created_at: string }>> {
  const r = await db().query(`SELECT mission, cron, created_by, created_at::text FROM schedules ORDER BY mission`);
  return r.rows;
}

/** Planifie (cron) ou déplanifie (null) une mission SUR ORDRE. Prend effet immédiatement. */
export async function setSchedule(mission: string, cron: string | null, by: string): Promise<void> {
  if (cron) {
    new Cron(cron, { timezone: config().TZ }); // valide l'expression, lève sinon
    await db().query(
      `INSERT INTO schedules(mission, cron, created_by) VALUES ($1,$2,$3) ON CONFLICT (mission) DO UPDATE SET cron=EXCLUDED.cron, created_by=EXCLUDED.created_by, created_at=now()`,
      [mission, cron, by],
    );
    addJob(mission, cron, `ordre:${by}`);
  } else {
    await db().query(`DELETE FROM schedules WHERE mission=$1`, [mission]);
    jobs.get(mission)?.stop();
    jobs.delete(mission);
    logger.info({ mission }, "cron retirée sur ordre");
  }
}

export async function startScheduler(): Promise<Cron[]> {
  const cfg = config();
  if (cfg.AUTONOMY_MODE === "scheduled") {
    // Une mission sans cron ne se lance que sur ordre (run_mission) ou par
    // un planning posé au panneau : c'est le cas des gros travaux à la
    // demande, comme la génération d'un site.
    for (const m of MISSIONS) if (m.cron) addJob(m.name, m.cron, "défaut");
    addJob("report", REPORT_CRON, "défaut");
  } else {
    logger.info("AUTONOMY_MODE=manual : aucune cron par défaut ; seul le planning ordonné s'exécute");
  }
  for (const s of await listSchedules()) addJob(s.mission, s.cron, `ordre:${s.created_by}`);
  return [...jobs.values()];
}

export function stopScheduler(): void {
  for (const j of jobs.values()) j.stop();
  jobs.clear();
}

export function scheduledJobs(): Array<{ name: string; pattern: string; next: Date | null }> {
  return [...jobs.entries()].map(([name, j]) => ({ name, pattern: j.getPattern() ?? "", next: j.nextRun() }));
}
