import { db } from "../memory/db.js";
import { emitEvent } from "../events.js";
// `ModelKind` vient de `missions/custom`, pas de `llm` : un agent exécute une
// mission, et une mission ne connaît que planner/worker/critical. « chat »
// est un mode de conversation, pas un mode de travail.
import { TOOLSETS, MODELS, type Toolset, type ModelKind } from "../missions/custom.js";

/**
 * Agents persistants.
 *
 * Un agent n'est pas une conversation ni une mission : c'est une identité qui
 * survit aux deux. Il a un rôle, une mémoire, des permissions, un budget et un
 * état, et le redémarrage du serveur ne lui en fait perdre aucun. Les missions
 * existantes ne disparaissent pas — elles deviennent ce qu'un agent sait
 * faire, au lieu d'être la seule chose qui existe.
 */

export const AGENT_ID_RE = /^[a-z][a-z0-9_-]{2,39}$/;

/**
 * Niveaux d'autonomie (section 18). Un entier, pas un curseur : le curseur
 * est une affaire d'interface, la décision d'exécuter est une affaire de
 * politique, et les mélanger produit un système dont personne ne sait ce
 * qu'il s'autorise.
 *   0 lecture seule          — observe, ne touche à rien
 *   1 analyse et propositions — écrit en mémoire, rend des rapports
 *   2 actions réversibles     — fichiers du workspace, brouillons, commits locaux
 *   3 actions externes        — publie, déploie, envoie, avec plafonds
 *   4 largement autonome      — mais le critique reste soumis à approbation
 * Ce que AUCUN niveau n'autorise sans accord explicite : paiement, achat,
 * suppression critique, changement de permissions ou de secrets.
 */
export const AUTONOMY = { READ_ONLY: 0, SUGGEST: 1, REVERSIBLE: 2, EXTERNAL: 3, AUTONOMOUS: 4 } as const;
export const MAX_AUTONOMY = 4;

export type AgentRow = {
  id: string;
  name: string;
  role: string;
  mission: string;
  instructions: string;
  model_kind: ModelKind;
  toolset: Toolset;
  autonomy: number;
  budget_usd: number;
  daily_usd: number;
  state: "idle" | "working" | "blocked" | "paused" | "error";
  version: number;
  parent_id: string | null;
  ephemeral: boolean;
  meta: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
};

/** `numeric` revient en chaîne du pilote pg : sans cette normalisation, un budget devient "2.00" et toute comparaison ment. */
function normalize(r: AgentRow): AgentRow {
  return { ...r, budget_usd: Number(r.budget_usd), daily_usd: Number(r.daily_usd), autonomy: Number(r.autonomy), version: Number(r.version) };
}

const COLS = `id, name, role, mission, instructions, model_kind, toolset, autonomy,
              budget_usd, daily_usd, state, version, parent_id, ephemeral, meta,
              created_by, created_at, updated_at`;

export type NewAgent = {
  id: string;
  name: string;
  role?: string;
  mission?: string;
  instructions?: string;
  modelKind?: ModelKind;
  toolset?: Toolset;
  autonomy?: number;
  budgetUsd?: number;
  dailyUsd?: number;
  parentId?: string | null;
  ephemeral?: boolean;
  createdBy?: string;
};

export async function createAgent(a: NewAgent): Promise<AgentRow> {
  if (!AGENT_ID_RE.test(a.id)) throw new Error(`identifiant d'agent invalide : « ${a.id} » (minuscules, chiffres, - et _ ; 3 à 40 caractères)`);
  if (a.toolset && !TOOLSETS.includes(a.toolset)) throw new Error(`toolset inconnu : ${a.toolset} (${TOOLSETS.join(", ")})`);
  if (a.modelKind && !MODELS.includes(a.modelKind)) throw new Error(`modèle inconnu : ${a.modelKind} (${MODELS.join(", ")})`);
  const autonomy = Math.max(0, Math.min(MAX_AUTONOMY, a.autonomy ?? AUTONOMY.SUGGEST));
  const r = await db().query<AgentRow>(
    `INSERT INTO agents(id, name, role, mission, instructions, model_kind, toolset, autonomy, budget_usd, daily_usd, parent_id, ephemeral, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, role=EXCLUDED.role, mission=EXCLUDED.mission,
       instructions=EXCLUDED.instructions, model_kind=EXCLUDED.model_kind,
       toolset=EXCLUDED.toolset, autonomy=EXCLUDED.autonomy,
       budget_usd=EXCLUDED.budget_usd, daily_usd=EXCLUDED.daily_usd,
       version = agents.version + 1, updated_at = now()
     RETURNING ${COLS}`,
    [
      a.id, a.name, a.role ?? "", a.mission ?? "", a.instructions ?? "",
      a.modelKind ?? "worker", a.toolset ?? "recherche", autonomy,
      a.budgetUsd ?? 2, a.dailyUsd ?? 5, a.parentId ?? null, a.ephemeral ?? false,
      a.createdBy ?? "operateur",
    ],
  );
  const row = normalize(r.rows[0]!);
  emitEvent({ kind: "agent.created", agentId: row.id, message: `agent « ${row.name} » v${row.version}`, data: { role: row.role, autonomy: row.autonomy } });
  return row;
}

export async function getAgent(id: string): Promise<AgentRow | undefined> {
  const r = await db().query<AgentRow>(`SELECT ${COLS} FROM agents WHERE id=$1`, [id]);
  return r.rows[0] ? normalize(r.rows[0]) : undefined;
}

export async function listAgents(opts: { parentId?: string | null; includeEphemeral?: boolean } = {}): Promise<AgentRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.parentId !== undefined) {
    args.push(opts.parentId);
    where.push(opts.parentId === null ? `parent_id IS NULL` : `parent_id=$${args.length}`);
  }
  if (!opts.includeEphemeral) where.push(`ephemeral = false`);
  const sql = `SELECT ${COLS} FROM agents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at`;
  const r = await db().query<AgentRow>(sql, args);
  return r.rows.map(normalize);
}

export async function setAgentState(id: string, state: AgentRow["state"], message = ""): Promise<void> {
  await db().query(`UPDATE agents SET state=$2, updated_at=now() WHERE id=$1`, [id, state]);
  emitEvent({ kind: "agent.state", agentId: id, message: message || state, data: { state } });
}

export async function deleteAgent(id: string): Promise<boolean> {
  const r = await db().query(`DELETE FROM agents WHERE id=$1`, [id]);
  if (r.rowCount) emitEvent({ kind: "agent.deleted", agentId: id, message: `agent ${id} supprimé` });
  return Boolean(r.rowCount);
}

/** Dépense d'un agent sur une fenêtre glissante, lue de son journal de tâches. */
export async function agentSpend(id: string, sinceHours = 24): Promise<number> {
  const r = await db().query<{ usd: string }>(
    `SELECT coalesce(sum(usd),0) AS usd FROM agent_tasks WHERE agent_id=$1 AND created_at > now() - ($2 || ' hours')::interval`,
    [id, String(sinceHours)],
  );
  return Number(r.rows[0]?.usd ?? 0);
}
