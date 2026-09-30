import { betaMemoryTool, type MemoryToolHandlers } from "@anthropic-ai/sdk/helpers/beta/memory";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { db } from "./db.js";
import { logger } from "../logger.js";
import type { Usage } from "../llm.js";

/* ------------------------------------------------------------------------ */
/* 1. Mémoire « fichiers » : outil memory_20250818 sauvegardé en Postgres    */
/* ------------------------------------------------------------------------ */

const ROOT = "/memories";

/**
 * Chaque agent voit un sous-arbre : le planificateur voit /memories, le
 * sous-agent « scraper » voit /memories/agents/scraper. Le modèle écrit
 * toujours des chemins commençant par /memories ; on les re-base sur sa racine.
 */
function makeNormalize(root: string) {
  return (p: string): string => {
    const clean = p.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (!clean.startsWith(ROOT)) throw new Error(`chemin hors de ${ROOT}: ${p}`);
    if (clean.includes("/../") || clean.endsWith("/..")) throw new Error(`chemin interdit: ${p}`);
    return root === ROOT ? clean : root + clean.slice(ROOT.length);
  };
}

function makeHandlers(root: string): MemoryToolHandlers {
  const normalize = makeNormalize(root);
  return {
  async view({ path, view_range }) {
    const p = normalize(path);
    // Répertoire ?
    const dir = await db().query<{ path: string }>(
      `SELECT path FROM memory_files WHERE path LIKE $1 || '/%' ORDER BY path`,
      [p.replace(/\/$/, "")],
    );
    if (dir.rowCount && dir.rowCount > 0 && !(await exists(p))) {
      return `Directory: ${p}\n` + dir.rows.map((r) => `- ${r.path}`).join("\n");
    }
    const row = await db().query<{ content: string }>(`SELECT content FROM memory_files WHERE path=$1`, [p]);
    if (!row.rows[0]) return p === ROOT ? `Directory: ${ROOT}\n(vide)` : `Error: ${p} n'existe pas`;
    const lines = row.rows[0].content.split("\n");
    const from = view_range?.[0] ?? 1;
    const to = view_range?.[1] ?? lines.length;
    return lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}: ${l}`)
      .join("\n");
  },
  async create({ path, file_text }) {
    const p = normalize(path);
    await db().query(
      `INSERT INTO memory_files(path, content) VALUES ($1,$2)
       ON CONFLICT (path) DO UPDATE SET content=EXCLUDED.content, updated_at=now()`,
      [p, file_text],
    );
    return `created ${p}`;
  },
  async str_replace({ path, old_str, new_str }) {
    const p = normalize(path);
    const row = await db().query<{ content: string }>(`SELECT content FROM memory_files WHERE path=$1`, [p]);
    const content = row.rows[0]?.content;
    if (content === undefined) return `Error: ${p} n'existe pas`;
    const count = content.split(old_str).length - 1;
    if (count !== 1) return `Error: old_str trouvé ${count} fois (attendu exactement 1)`;
    await db().query(`UPDATE memory_files SET content=$2, updated_at=now() WHERE path=$1`, [p, content.replace(old_str, new_str)]);
    return `edited ${p}`;
  },
  async insert({ path, insert_line, insert_text }) {
    const p = normalize(path);
    const row = await db().query<{ content: string }>(`SELECT content FROM memory_files WHERE path=$1`, [p]);
    const content = row.rows[0]?.content;
    if (content === undefined) return `Error: ${p} n'existe pas`;
    const lines = content.split("\n");
    lines.splice(insert_line, 0, insert_text.replace(/\n$/, ""));
    await db().query(`UPDATE memory_files SET content=$2, updated_at=now() WHERE path=$1`, [p, lines.join("\n")]);
    return `inserted into ${p}`;
  },
  async delete({ path }) {
    const p = normalize(path);
    const res = await db().query(`DELETE FROM memory_files WHERE path=$1 OR path LIKE $1 || '/%'`, [p]);
    return `deleted ${res.rowCount ?? 0} file(s)`;
  },
  async rename({ old_path, new_path }) {
    const a = normalize(old_path);
    const b = normalize(new_path);
    await db().query(`UPDATE memory_files SET path=$2, updated_at=now() WHERE path=$1`, [a, b]);
    return `renamed ${a} -> ${b}`;
  },
  };
}

async function exists(p: string): Promise<boolean> {
  const r = await db().query(`SELECT 1 FROM memory_files WHERE path=$1`, [p]);
  return (r.rowCount ?? 0) > 0;
}

/** Outil mémoire lié à une racine (namespace). Le modèle gère lui-même /memories. */
export function makeMemoryTool(root: string = ROOT) {
  return betaMemoryTool(makeHandlers(root));
}

/** Outil mémoire global du planificateur. */
export const memoryTool = makeMemoryTool();

/** Racine mémoire d'un sous-agent. */
export function agentMemoryRoot(role: string): string {
  return `${ROOT}/agents/${role.replace(/[^a-z0-9_-]/gi, "_")}`;
}

/** Injecté au début de chaque mission : ce que l'agent a choisi de retenir (sous `prefix`). */
export async function memoryDigest(maxChars = 12_000, prefix: string = ROOT): Promise<string> {
  const rows = await db().query<{ path: string; content: string }>(
    `SELECT path, content FROM memory_files WHERE path = $1 OR path LIKE $1 || '/%' ORDER BY path`,
    [prefix],
  );
  let out = "";
  for (const r of rows.rows) {
    const block = `\n### ${r.path}\n${r.content}\n`;
    if (out.length + block.length > maxChars) {
      out += `\n(… ${rows.rows.length} fichiers, tronqué ; utilise l'outil memory pour lire le reste)`;
      break;
    }
    out += block;
  }
  return out || "(mémoire vide — première exécution)";
}

/* ------------------------------------------------------------------------ */
/* 2. Mémoire sémantique : faits atomiques, recherche full-text              */
/* ------------------------------------------------------------------------ */

export const rememberFact = betaZodTool({
  name: "remember_fact",
  description:
    "Enregistre un fait atomique et sourcé dans la mémoire long terme (prix d'un service, changement d'un concurrent, décision prise). Un fait = une phrase vérifiable.",
  inputSchema: z.object({
    topic: z.string().describe("Sujet court, ex: 'iptv:providerX:pricing'"),
    fact: z.string().max(600),
    source_url: z.string().url().optional(),
    confidence: z.number().min(0).max(1).default(0.7),
    ttl_days: z.number().int().positive().optional().describe("Expiration si le fait est volatil"),
  }),
  run: async (i) => {
    await db().query(
      `INSERT INTO facts(topic, fact, source_url, confidence, expires_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int || ' days')::interval END)`,
      [i.topic, i.fact, i.source_url ?? null, i.confidence, i.ttl_days ?? null],
    );
    return "ok";
  },
});

export const recallFacts = betaZodTool({
  name: "recall_facts",
  description: "Recherche full-text dans la mémoire long terme. Retourne les faits non expirés, les plus récents d'abord.",
  inputSchema: z.object({
    query: z.string().describe("Mots-clés (syntaxe websearch: guillemets, OR, -)"),
    topic_prefix: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  run: async (i) => {
    const r = await db().query<{ topic: string; fact: string; source_url: string | null; created_at: string; confidence: number }>(
      `SELECT topic, fact, source_url, created_at, confidence
         FROM facts
        WHERE (expires_at IS NULL OR expires_at > now())
          AND tsv @@ websearch_to_tsquery('simple', $1)
          AND ($2::text IS NULL OR topic LIKE $2 || '%')
        ORDER BY created_at DESC LIMIT $3`,
      [i.query, i.topic_prefix ?? null, i.limit],
    );
    if (r.rowCount === 0) return "aucun fait trouvé";
    return r.rows
      .map((f) => `- [${f.topic}] (${new Date(f.created_at).toISOString().slice(0, 10)}, c=${f.confidence}) ${f.fact}${f.source_url ? ` <${f.source_url}>` : ""}`)
      .join("\n");
  },
});

/* ------------------------------------------------------------------------ */
/* 3. Tâches longues (kanban interne)                                        */
/* ------------------------------------------------------------------------ */

export const taskTool = betaZodTool({
  name: "task_board",
  description: "Kanban interne persistant : lister, créer, mettre à jour des tâches multi-jours. Utilise-le pour reprendre le travail d'un jour sur l'autre.",
  inputSchema: z.object({
    action: z.enum(["list", "create", "update"]),
    id: z.number().int().optional(),
    title: z.string().optional(),
    status: z.enum(["todo", "doing", "blocked", "done"]).optional(),
    priority: z.number().int().min(1).max(5).optional(),
    notes: z.string().optional(),
  }),
  run: async (i) => {
    if (i.action === "list") {
      const r = await db().query<{ id: number; title: string; status: string; priority: number; notes: string | null }>(
        `SELECT id, title, status, priority, notes FROM tasks WHERE status <> 'done' ORDER BY priority, id`,
      );
      return r.rows.map((t) => `#${t.id} [${t.status}] p${t.priority} ${t.title}${t.notes ? ` — ${t.notes}` : ""}`).join("\n") || "(aucune tâche ouverte)";
    }
    if (i.action === "create") {
      if (!i.title) return "Error: title requis";
      const r = await db().query<{ id: number }>(`INSERT INTO tasks(title, priority, notes) VALUES ($1,$2,$3) RETURNING id`, [i.title, i.priority ?? 3, i.notes ?? null]);
      return `created #${r.rows[0]!.id}`;
    }
    if (!i.id) return "Error: id requis";
    await db().query(
      `UPDATE tasks SET status=COALESCE($2,status), priority=COALESCE($3,priority), notes=COALESCE($4,notes), title=COALESCE($5,title), updated_at=now() WHERE id=$1`,
      [i.id, i.status ?? null, i.priority ?? null, i.notes ?? null, i.title ?? null],
    );
    return `updated #${i.id}`;
  },
});

/* ------------------------------------------------------------------------ */
/* 4. Journal des missions + dépense                                          */
/* ------------------------------------------------------------------------ */

export async function openEpisode(mission: string, meta: Record<string, unknown> = {}): Promise<number> {
  const r = await db().query<{ id: number }>(`INSERT INTO episodes(mission, meta) VALUES ($1,$2) RETURNING id`, [mission, meta]);
  return r.rows[0]!.id;
}

export async function closeEpisode(id: number, status: "ok" | "failed" | "budget", summary: string, usage: Usage, error?: string): Promise<void> {
  await db().query(
    `UPDATE episodes SET finished_at=now(), status=$2, summary=$3, usd=$4, iterations=$5, error=$6 WHERE id=$1`,
    [id, status, summary.slice(0, 20_000), usage.usd, usage.iterations, error ?? null],
  );
  await db().query(
    `INSERT INTO spend(day, usd) VALUES (CURRENT_DATE, $1) ON CONFLICT (day) DO UPDATE SET usd = spend.usd + EXCLUDED.usd`,
    [usage.usd],
  );
}

export async function spentToday(): Promise<number> {
  const r = await db().query<{ usd: string }>(`SELECT usd FROM spend WHERE day = CURRENT_DATE`);
  return Number(r.rows[0]?.usd ?? 0);
}

export async function episodesSince(hours: number): Promise<Array<{ mission: string; status: string; summary: string | null; usd: string; started_at: string; error: string | null }>> {
  const r = await db().query(
    `SELECT mission, status, summary, usd, started_at, error FROM episodes WHERE started_at > now() - ($1 || ' hours')::interval ORDER BY started_at`,
    [String(hours)],
  );
  return r.rows;
}

export async function saveReport(markdown: string): Promise<void> {
  await db().query(
    `INSERT INTO reports(day, markdown) VALUES (CURRENT_DATE, $1) ON CONFLICT (day) DO UPDATE SET markdown=EXCLUDED.markdown`,
    [markdown],
  );
}

export async function markReportDelivered(): Promise<void> {
  await db().query(`UPDATE reports SET delivered=true WHERE day=CURRENT_DATE`);
}

/* ------------------------------------------------------------------------ */
/* 5. Mémoire de mission : ce que l'exécution précédente a laissé            */
/* ------------------------------------------------------------------------ */

/**
 * Racine délibérément SÉPARÉE de /memories.
 *
 * `memoryDigest()` interroge `path = prefix OR path LIKE prefix || '/%'` avec
 * pour préfixe /memories : un passage rangé sous /runs n'y entre donc jamais.
 * C'est le but. /memories est ce que l'agent a CHOISI de retenir ; /runs est un
 * état machine que l'orchestrateur réinjecte au bon endroit. Les confondre
 * ferait grossir chaque prompt de toutes les exécutions passées, et le digest
 * cesserait d'être une mémoire pour devenir un journal.
 *
 * Conséquence pratique : l'outil memory du modèle refuse tout chemin hors de
 * /memories (`makeNormalize`), donc le modèle ne peut ni lire ni écraser ces
 * fichiers. Seul le code ci-dessous y touche.
 */
const RUNS_ROOT = "/runs";

/** Un nom de mission peut contenir « : » (swarm:coder) — on le garde, il fait partie de la clé. */
export function missionRunPath(mission: string): string {
  return `${RUNS_ROOT}/${mission.replace(/[^a-z0-9_:.-]/gi, "_")}/last_run.md`;
}

export type MissionOutcome = {
  status: "ok" | "failed" | "budget" | "skipped";
  summary: string;
  usd?: number;
  error?: string;
};

/**
 * Le passage précédent, prêt à coller dans un prompt.
 *
 * Renvoie le bloc <passage_precedent> complet, ou "" s'il n'y a rien à dire —
 * de sorte qu'un appelant puisse toujours écrire `${await readMissionMemory(m)}`
 * sans laisser une balise vide dans le prompt. Le nom de la balise vit ici, en
 * un seul endroit, plutôt que recopié sur les cinq sites d'appel.
 *
 * Ne lève jamais : une base injoignable doit coûter la mémoire, pas la mission.
 */
export async function readMissionMemory(mission: string): Promise<string> {
  try {
    const [file, eps] = await Promise.all([
      db().query<{ content: string; updated_at: string }>(
        `SELECT content, updated_at FROM memory_files WHERE path = $1`,
        [missionRunPath(mission)],
      ),
      db().query<{ status: string; summary: string | null; usd: string; error: string | null; finished_at: string }>(
        `SELECT status, summary, usd, error, finished_at
           FROM episodes
          WHERE mission = $1 AND finished_at IS NOT NULL
          ORDER BY finished_at DESC
          LIMIT 3`,
        [mission],
      ),
    ]);

    const parts: string[] = [];
    const last = file.rows[0];
    if (last?.content) {
      parts.push(`## Dernière exécution (${new Date(last.updated_at).toISOString()})\n${last.content}`);
    }
    if (eps.rowCount) {
      const lines = eps.rows.map(
        (e) =>
          `- ${new Date(e.finished_at).toISOString().slice(0, 16).replace("T", " ")} — ${e.status} — ${Number(e.usd).toFixed(2)} USD` +
          `${e.summary ? `\n  ${e.summary.replace(/\s+/g, " ").slice(0, 400)}` : ""}` +
          `${e.error ? `\n  ERREUR: ${e.error.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
      );
      parts.push(`## 3 derniers épisodes terminés\n${lines.join("\n")}`);
    }
    if (parts.length === 0) return "";
    return `<passage_precedent>\n${parts.join("\n\n")}\n</passage_precedent>\n\n`;
  } catch (err) {
    logger.warn({ mission, err: String(err) }, "mémoire de mission illisible — on continue sans");
    return "";
  }
}

/**
 * Écrit le passage de cette exécution, en REMPLAÇANT le précédent.
 *
 * `ON CONFLICT (path) DO UPDATE` sur la clé primaire : un chemin = une ligne,
 * donc pas de doublon qui s'accumulerait au fil des nuits. On garde la dernière
 * exécution seulement ; l'historique long vit dans `episodes`, qui est le
 * journal immuable.
 *
 * Ne lève jamais, et pour la même raison que la lecture : c'est la dernière
 * chose que fait une mission, souvent dans un `catch`. Une écriture qui échoue
 * ne doit pas transformer une mission réussie en mission perdue, ni masquer
 * l'erreur d'origine.
 */
export async function writeMissionMemory(mission: string, outcome: MissionOutcome): Promise<void> {
  const body = [
    `- statut: ${outcome.status}`,
    outcome.usd !== undefined ? `- coût: ${outcome.usd.toFixed(2)} USD` : undefined,
    outcome.error ? `- erreur: ${outcome.error.replace(/\s+/g, " ").slice(0, 1_000)}` : undefined,
    "",
    outcome.summary.trim() ? outcome.summary.trim().slice(0, 8_000) : "(aucun compte rendu)",
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  try {
    await db().query(
      `INSERT INTO memory_files(path, content) VALUES ($1, $2)
       ON CONFLICT (path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [missionRunPath(mission), body],
    );
  } catch (err) {
    logger.warn({ mission, err: String(err) }, "mémoire de mission non écrite — on continue");
  }
}

/* ------------------------------------------------------------------------ */
/* 6. Auto-évaluation : l'agent relit son propre journal                     */
/* ------------------------------------------------------------------------ */

export const episodesTool = betaZodTool({
  name: "read_episodes",
  description:
    "Journal des missions passées (statut, coût, itérations, résumé, erreur). Sert à l'auto-évaluation : repérer ce qui échoue, ce qui coûte trop, ce qui boucle. Retourne aussi le taux de succès par mission sur la période.",
  inputSchema: z.object({
    hours: z.number().int().min(1).max(24 * 30).default(24),
    mission: z.string().optional().describe("Filtre sur un nom de mission (préfixe accepté, ex: 'swarm:')"),
    limit: z.number().int().min(1).max(200).default(60),
  }),
  run: async (i) => {
    const rows = await db().query<{ mission: string; status: string; usd: string; iterations: number; summary: string | null; error: string | null; started_at: string; finished_at: string | null }>(
      `SELECT mission, status, usd, iterations, summary, error, started_at, finished_at
         FROM episodes
        WHERE started_at > now() - ($1 || ' hours')::interval
          AND ($2::text IS NULL OR mission LIKE $2 || '%')
        ORDER BY started_at DESC LIMIT $3`,
      [String(i.hours), i.mission ?? null, i.limit],
    );
    if (rows.rowCount === 0) return "aucun épisode sur la période";
    const stats = await db().query<{ mission: string; n: string; ok: string; usd: string; iters: string }>(
      `SELECT mission, count(*) AS n, count(*) FILTER (WHERE status='ok') AS ok, round(avg(usd),3) AS usd, round(avg(iterations)) AS iters
         FROM episodes WHERE started_at > now() - ($1 || ' hours')::interval GROUP BY mission ORDER BY mission`,
      [String(i.hours)],
    );
    const head = stats.rows.map((r) => `${r.mission}: ${r.ok}/${r.n} ok, ${r.usd} USD/mission, ${r.iters} tours`).join("\n");
    const body = rows.rows
      .map((e) => {
        const dur = e.finished_at ? Math.round((new Date(e.finished_at).getTime() - new Date(e.started_at).getTime()) / 60000) : "?";
        return `## ${e.mission} — ${e.status} — ${Number(e.usd).toFixed(2)} USD — ${e.iterations} tours — ${dur} min — ${e.started_at}\n${(e.summary ?? "").slice(0, 900)}${e.error ? `\nERREUR: ${e.error.slice(0, 400)}` : ""}`;
      })
      .join("\n\n");
    return `TAUX DE SUCCÈS (${i.hours} h)\n${head}\n\n${body}`;
  },
});
