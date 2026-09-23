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
  `CREATE TABLE IF NOT EXISTS chat_messages (
     id      BIGSERIAL PRIMARY KEY,
     channel TEXT NOT NULL,
     peer    TEXT NOT NULL,
     role    TEXT NOT NULL,
     content TEXT NOT NULL,
     ext_id  TEXT UNIQUE,
     ts      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS chat_peer_ts ON chat_messages (peer, ts DESC)`,
  `CREATE TABLE IF NOT EXISTS schedules (
     mission    TEXT PRIMARY KEY,
     cron       TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS approvals (
     code       TEXT PRIMARY KEY,
     tool       TEXT NOT NULL,
     args       TEXT NOT NULL,
     decision   TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     decided_at TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS feedback (
     id         BIGSERIAL PRIMARY KEY,
     peer       TEXT NOT NULL,
     rating     SMALLINT NOT NULL,
     comment    TEXT,
     episode_id BIGINT,
     mission    TEXT,
     ts         TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS eval_runs (
     id         BIGSERIAL PRIMARY KEY,
     ran_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     cases      INT NOT NULL,
     passed     INT NOT NULL,
     avg_score  NUMERIC(4,2) NOT NULL,
     usd        NUMERIC(10,4) NOT NULL,
     details    JSONB NOT NULL
   )`,
  // Missions définies par l'opérateur, en base plutôt qu'en dur : il en crée
  // autant qu'il veut depuis WhatsApp, sans recompiler ni redéployer.
  `CREATE TABLE IF NOT EXISTS custom_missions (
     name               TEXT PRIMARY KEY,
     objective          TEXT NOT NULL,
     toolset            TEXT NOT NULL DEFAULT 'recherche',
     model              TEXT NOT NULL DEFAULT 'worker',
     budget_usd         NUMERIC(6,2) NOT NULL DEFAULT 1.0,
     max_iterations     INT NOT NULL DEFAULT 30,
     allow_irreversible BOOLEAN NOT NULL DEFAULT false,
     created_by         TEXT NOT NULL,
     created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // --- Agents persistants -------------------------------------------------
  // Jusqu'ici tout était centré sur la MISSION : un cahier des charges lancé,
  // exécuté, oublié. Un agent, lui, existe entre deux exécutions — il a une
  // identité, une mémoire, des permissions et un état qui survivent au
  // redémarrage. Les missions restent : elles deviennent ce qu'un agent SAIT
  // faire, au lieu d'être tout ce qui existe.
  `CREATE TABLE IF NOT EXISTS agents (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     role          TEXT NOT NULL DEFAULT '',
     mission       TEXT NOT NULL DEFAULT '',
     instructions  TEXT NOT NULL DEFAULT '',
     model_kind    TEXT NOT NULL DEFAULT 'worker',
     toolset       TEXT NOT NULL DEFAULT 'recherche',
     autonomy      INT NOT NULL DEFAULT 1,
     budget_usd    NUMERIC(8,2) NOT NULL DEFAULT 2.0,
     daily_usd     NUMERIC(8,2) NOT NULL DEFAULT 5.0,
     state         TEXT NOT NULL DEFAULT 'idle',
     version       INT NOT NULL DEFAULT 1,
     parent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
     ephemeral     BOOLEAN NOT NULL DEFAULT false,
     meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_by    TEXT NOT NULL DEFAULT 'operateur',
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS agents_parent ON agents (parent_id)`,

  // Une tâche d'agent, DURABLE. `attempt` et `checkpoint` sont ce qui
  // distingue ce moteur d'un simple appel de fonction : un processus tué au
  // milieu laisse la ligne en 'running', et le démarrage suivant la reprend
  // au lieu de la perdre. `depends_on` porte le graphe (section 31).
  `CREATE TABLE IF NOT EXISTS agent_tasks (
     id            BIGSERIAL PRIMARY KEY,
     agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     parent_task   BIGINT REFERENCES agent_tasks(id) ON DELETE CASCADE,
     title         TEXT NOT NULL,
     brief         TEXT NOT NULL DEFAULT '',
     mission       TEXT,
     status        TEXT NOT NULL DEFAULT 'pending',
     priority      INT NOT NULL DEFAULT 3,
     depends_on    BIGINT[] NOT NULL DEFAULT '{}',
     attempt       INT NOT NULL DEFAULT 0,
     max_attempts  INT NOT NULL DEFAULT 2,
     checkpoint    JSONB NOT NULL DEFAULT '{}'::jsonb,
     result        TEXT,
     error         TEXT,
     usd           NUMERIC(10,4) NOT NULL DEFAULT 0,
     claimed_by    TEXT,
     claimed_at    TIMESTAMPTZ,
     deadline_at   TIMESTAMPTZ,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at   TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS agent_tasks_queue ON agent_tasks (status, priority, created_at)`,
  `CREATE INDEX IF NOT EXISTS agent_tasks_agent ON agent_tasks (agent_id, created_at DESC)`,

  // Journal d'activité et bus d'événements : la même table sert la timeline
  // (section 23) et l'historique des événements (section 17). Les séparer
  // aurait produit deux vérités sur ce qui s'est passé.
  `CREATE TABLE IF NOT EXISTS events (
     id         BIGSERIAL PRIMARY KEY,
     kind       TEXT NOT NULL,
     agent_id   TEXT,
     task_id    BIGINT,
     level      TEXT NOT NULL DEFAULT 'info',
     message    TEXT NOT NULL DEFAULT '',
     data       JSONB NOT NULL DEFAULT '{}'::jsonb,
     ts         TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS events_agent_ts ON events (agent_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS events_kind_ts ON events (kind, ts DESC)`,

  // Coffre d'identifiants (voir vault.ts). Le mot de passe est chiffré avec
  // une clé qui vit dans le .env, pas ici : une sauvegarde de cette base,
  // seule, ne livre aucun secret.
  `CREATE TABLE IF NOT EXISTS credentials (
     site         TEXT PRIMARY KEY,
     login        TEXT NOT NULL,
     secret       TEXT NOT NULL,
     totp         TEXT,
     url          TEXT NOT NULL DEFAULT '',
     note         TEXT NOT NULL DEFAULT '',
     uses         INTEGER NOT NULL DEFAULT 0,
     last_used_at TIMESTAMPTZ,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // Billets d'accès au coffre : à usage unique, valables quelques minutes.
  // Ils remplacent le jeton de l'API dans l'URL. Un jeton d'API dans une
  // adresse finit recopié — dans un historique, dans une capture d'écran,
  // dans un message. Un billet recopié, lui, est déjà mort.
  `CREATE TABLE IF NOT EXISTS vault_tickets (
     id         TEXT PRIMARY KEY,
     expires_at TIMESTAMPTZ NOT NULL,
     used_at    TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // Fournisseurs de modèles, pilotés depuis le panneau plutôt que par le
  // .env. Raison : changer une clé ou mettre un fournisseur en pause ne doit
  // pas demander un accès SSH et un redémarrage. La clé est chiffrée avec la
  // même clé maîtresse que le coffre — elle n'est jamais en clair en base.
  `CREATE TABLE IF NOT EXISTS providers (
     id            TEXT PRIMARY KEY,
     label         TEXT NOT NULL DEFAULT '',
     kind          TEXT NOT NULL DEFAULT 'openai_compat',
     base_url      TEXT NOT NULL DEFAULT '',
     model         TEXT NOT NULL DEFAULT '',
     api_key       TEXT,
     enabled       BOOLEAN NOT NULL DEFAULT true,
     priority      INTEGER NOT NULL DEFAULT 50,
     roles         TEXT NOT NULL DEFAULT 'chat,worker',
     daily_cap_usd NUMERIC(8,2) NOT NULL DEFAULT 0,
     note          TEXT NOT NULL DEFAULT '',
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // Une ligne par appel de modèle. `spend` ne garde qu'un total par jour :
  // impossible d'y lire quel fournisseur coûte quoi, ni de plafonner l'un
  // sans l'autre. C'est la table qui alimente le panneau.
  `CREATE TABLE IF NOT EXISTS usage_log (
     id            BIGSERIAL PRIMARY KEY,
     provider      TEXT NOT NULL,
     model         TEXT NOT NULL,
     kind          TEXT NOT NULL DEFAULT '',
     input_tokens  INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     usd           NUMERIC(10,4) NOT NULL DEFAULT 0,
     ok            BOOLEAN NOT NULL DEFAULT true,
     ts            TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Ajoutée après coup : le panneau ne gère plus seulement les modèles, mais
  // tout service à clé — GitHub, Vercel, la recherche. `CREATE TABLE IF NOT
  // EXISTS` ne touche pas une table existante, d'où l'ALTER explicite.
  `ALTER TABLE providers ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'modele'`,

  // Réglages modifiables sans redémarrage. Le .env reste la valeur par
  // défaut ; cette table ne contient que ce qui a été changé depuis le
  // panneau, pour qu'un réglage jamais touché suive le fichier.
  `CREATE TABLE IF NOT EXISTS settings (
     cle        TEXT PRIMARY KEY,
     valeur     TEXT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS usage_log_ts ON usage_log (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS usage_log_provider_ts ON usage_log (provider, ts DESC)`,

  // Rappels et tâches planifiées (Grok Tasks) : n'importe quelle demande,
  // une fois ou sur un rythme. `en_cours` empêche deux exécutions du même
  // rappel si deux processus tournent, ou si un passage déborde sur le suivant.
  `CREATE TABLE IF NOT EXISTS rappels (
     id               BIGSERIAL PRIMARY KEY,
     peer             TEXT NOT NULL,
     type             TEXT NOT NULL CHECK (type IN ('rappel','tache')),
     quoi             TEXT NOT NULL,
     cron             TEXT,
     prochain         TIMESTAMPTZ,
     actif            BOOLEAN NOT NULL DEFAULT true,
     en_cours         BOOLEAN NOT NULL DEFAULT false,
     executions       INTEGER NOT NULL DEFAULT 0,
     derniere         TIMESTAMPTZ,
     dernier_resultat TEXT,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS rappels_dus ON rappels (prochain) WHERE actif`,

  // Compétences (Grok Skills) : ce qu'on lui apprend une fois et qu'il
  // applique ensuite de lui-même. Le nom est la clé : réapprendre une
  // compétence du même nom la remplace, comme chez Grok où « la tienne
  // prime toujours ».
  `CREATE TABLE IF NOT EXISTS competences (
     nom          TEXT PRIMARY KEY,
     quand        TEXT NOT NULL,
     instructions TEXT NOT NULL,
     actif        BOOLEAN NOT NULL DEFAULT true,
     source       TEXT NOT NULL DEFAULT 'chat',
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // Déclencheurs e-mail (Grok Automations) : une condition sur les messages
  // qui arrivent, une consigne à exécuter, le résultat sur WhatsApp.
  `CREATE TABLE IF NOT EXISTS declencheurs_email (
     id          BIGSERIAL PRIMARY KEY,
     nom         TEXT NOT NULL,
     expediteur  TEXT NOT NULL DEFAULT '',
     sujet       TEXT NOT NULL DEFAULT '',
     piece_jointe BOOLEAN NOT NULL DEFAULT false,
     consigne    TEXT NOT NULL,
     actif       BOOLEAN NOT NULL DEFAULT true,
     declenches  INTEGER NOT NULL DEFAULT 0,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Un message déjà traité ne se retraite jamais : sans cette table, chaque
  // passage renverrait le résumé du même e-mail tant qu'il reste récent.
  `CREATE TABLE IF NOT EXISTS declencheurs_vus (
     declencheur_id BIGINT NOT NULL REFERENCES declencheurs_email(id) ON DELETE CASCADE,
     message_id     TEXT NOT NULL,
     vu_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (declencheur_id, message_id)
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
