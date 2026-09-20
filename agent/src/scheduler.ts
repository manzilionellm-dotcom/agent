import { Cron } from "croner";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { db } from "./memory/db.js";
import { spentToday } from "./memory/store.js";
import { MISSIONS, runMission, type Mission } from "./missions/index.js";
import { buildAndDeliverReport } from "./missions/report.js";

/**
 * Scheduler in-process (croner) + verrou Postgres (advisory lock) :
 *   - une mission ne tourne jamais deux fois en parallèle (redémarrage, deux réplicas) ;
 *   - le plafond journalier est vérifié AVANT de lancer ;
 *   - une mission qui plante ne tue pas le process, elle est journalisée et reprise au tick suivant.
 * Le rapport du matin est une cron à part (07:30 locale) pour qu'il parte même si une mission traîne.
 */

const REPORT_CRON = "30 7 * * *";

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

export async function launch(m: Mission): Promise<void> {
  const cfg = config();
  const spent = await spentToday();
  if (spent >= cfg.DAILY_BUDGET_USD) {
    logger.error({ spent, cap: cfg.DAILY_BUDGET_USD, mission: m.name }, "plafond journalier atteint — mission non lancée");
    return;
  }
  await withLock(m.name, () => runMission(m));
}

export function startScheduler(): Cron[] {
  const tz = config().TZ;
  const jobs = MISSIONS.map(
    (m) =>
      new Cron(m.cron, { timezone: tz, protect: true, catch: (e) => logger.error({ err: String(e), mission: m.name }, "cron erreur") }, () => launch(m)),
  );
  jobs.push(
    new Cron(REPORT_CRON, { timezone: tz, protect: true, catch: (e) => logger.error({ err: String(e) }, "rapport erreur") }, async () => {
      await withLock("report", buildAndDeliverReport);
    }),
  );
  for (const j of jobs) logger.info({ next: j.nextRun()?.toISOString(), pattern: j.getPattern() }, "cron planifiée");
  return jobs;
}
