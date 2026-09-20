import { db, closeDb } from "./db.js";

/**
 * Schéma de la mémoire persistante. Trois couches :
 *   1. `memory_files`  — mémoire « fichiers » vue par le modèle via l'outil memory_20250818
 *                        (/memories/...). C'est ce que l'agent lit/écrit lui-même.
 *   2. `episodes`      — journal immuable de chaque mission (entrée, sortie, coût, statut).
 *   3. `facts`         — mémoire sémantique : faits atomiques indexés en full-text,
 *                        avec source, confiance et date (permet l'oubli/actualisation).
 *   + `tasks`          — état des tâches longues (kanban interne), `locks` pour le scheduler,
 *   + `spend`          — compteur de dépense par jour pour le plafond global.
 *
 * Idempotent : ré-exécutable à chaque boot.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS memory_files (
     path        TEXT PRIMARY KEY,
     content     TEXT NOT NULL DEFAULT '',
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS episodes (
     id          BIGSERIAL PRIMARY KEY,
     mission     TEXT NOT NULL,
     started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ,
     status      TEXT NOT NULL DEFAULT 'running',
     summary     TEXT,
     usd         NUMERIC(10,4) NOT NULL DEFAULT 0,
     iterations  INT NOT NULL DEFAULT 0,
     error       TEXT,
     meta        JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS episodes_mission_started ON episodes (mission, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS facts (
     id          BIGSERIAL PRIMARY KEY,
     topic       TEXT NOT NULL,
     fact        TEXT NOT NULL,
     source_url  TEXT,
     confidence  REAL NOT NULL DEFAULT 0.7,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at  TIMESTAMPTZ,
     tsv         tsvector GENERATED ALWAYS AS (to_tsvector('simple', topic || ' ' || fact)) STORED
   )`,
  `CREATE INDEX IF NOT EXISTS facts_tsv ON facts USING GIN (tsv)`,
  `CREATE INDEX IF NOT EXISTS facts_topic ON facts (topic, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id          BIGSERIAL PRIMARY KEY,
     title       TEXT NOT NULL,
     status      TEXT NOT NULL DEFAULT 'todo',
     priority    INT NOT NULL DEFAULT 3,
     notes       TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS spend (
     day   DATE PRIMARY KEY,
     usd   NUMERIC(10,4) NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS reports (
     id          BIGSERIAL PRIMARY KEY,
     day         DATE NOT NULL UNIQUE,
     markdown    TEXT NOT NULL,
     delivered   BOOLEAN NOT NULL DEFAULT false,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

export async function migrate(): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    for (const sql of MIGRATIONS) await client.query(sql);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Exécution directe : `npm run migrate`
if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  migrate()
    .then(async () => {
      console.log("migrations OK");
      await closeDb();
    })
    .catch(async (e) => {
      console.error(e);
      await closeDb();
      process.exit(1);
    });
}
