import { randomUUID } from "node:crypto";
import { db } from "../memory/db.js";
import { logger } from "../logger.js";
import { emitEvent } from "../events.js";

/**
 * Moteur de tâches DURABLE (sections 29, 30, 31).
 *
 * Ce qui distingue ce moteur d'un simple appel de fonction tient en trois
 * colonnes : `claimed_by`, `attempt` et `checkpoint`.
 *
 *  - `claimed_by` identifie le processus qui exécute. Un processus tué laisse
 *    sa marque : au démarrage suivant, on sait que cette tâche était en vol et
 *    qu'elle n'a pas fini toute seule.
 *  - `attempt` compte les reprises, pour qu'une tâche qui échoue toujours
 *    s'arrête au lieu de tourner en rond pour l'éternité.
 *  - `checkpoint` garde l'avancement. Une tâche de deux heures reprise à zéro
 *    n'est pas une reprise, c'est une deuxième facture.
 *
 * La prise de tâche utilise `FOR UPDATE SKIP LOCKED` : deux orchestrateurs
 * peuvent tourner côte à côte sans jamais exécuter la même tâche deux fois,
 * et sans s'attendre l'un l'autre.
 */

/** Identité de CE processus. Change à chaque redémarrage — c'est exactement ce qui permet de reconnaître une tâche orpheline. */
export const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

export type TaskStatus = "pending" | "running" | "done" | "failed" | "blocked" | "cancelled";

export type TaskRow = {
  id: number;
  agent_id: string;
  parent_task: number | null;
  title: string;
  brief: string;
  mission: string | null;
  status: TaskStatus;
  priority: number;
  depends_on: number[];
  attempt: number;
  max_attempts: number;
  checkpoint: Record<string, unknown>;
  result: string | null;
  error: string | null;
  usd: number;
  claimed_by: string | null;
  deadline_at: string | null;
  created_at: string;
  finished_at: string | null;
};

const COLS = `id, agent_id, parent_task, title, brief, mission, status, priority, depends_on,
              attempt, max_attempts, checkpoint, result, error, usd, claimed_by,
              deadline_at, created_at, finished_at`;

const norm = (r: TaskRow): TaskRow => ({ ...r, usd: Number(r.usd), depends_on: r.depends_on ?? [] });

export type NewTask = {
  agentId: string;
  title: string;
  brief?: string;
  mission?: string;
  priority?: number;
  dependsOn?: number[];
  parentTask?: number;
  maxAttempts?: number;
  deadlineAt?: Date;
};

export async function createTask(t: NewTask): Promise<TaskRow> {
  const r = await db().query<TaskRow>(
    `INSERT INTO agent_tasks(agent_id, title, brief, mission, priority, depends_on, parent_task, max_attempts, deadline_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
    [t.agentId, t.title, t.brief ?? "", t.mission ?? null, t.priority ?? 3, t.dependsOn ?? [], t.parentTask ?? null, t.maxAttempts ?? 2, t.deadlineAt ?? null],
  );
  const row = norm(r.rows[0]!);
  emitEvent({ kind: "task.created", agentId: row.agent_id, taskId: row.id, message: row.title, data: { priority: row.priority, dependsOn: row.depends_on } });
  return row;
}

/**
 * Prend la tâche prête la plus prioritaire et la marque comme sienne.
 *
 * « Prête » veut dire : en attente, échéance non dépassée, et TOUTES ses
 * dépendances terminées. Le `NOT EXISTS` fait ce travail en base plutôt qu'en
 * mémoire — sinon deux processus concurrents liraient le même graphe avant que
 * l'un ait écrit son résultat, et lanceraient tous deux une tâche non prête.
 */
export async function claimNext(workerId = WORKER_ID): Promise<TaskRow | undefined> {
  const r = await db().query<TaskRow>(
    `UPDATE agent_tasks SET status='running', claimed_by=$1, claimed_at=now(), attempt=attempt+1, updated_at=now()
     WHERE id = (
       SELECT t.id FROM agent_tasks t
       WHERE t.status='pending'
         AND (t.deadline_at IS NULL OR t.deadline_at > now())
         AND NOT EXISTS (
           SELECT 1 FROM agent_tasks d
           WHERE d.id = ANY(t.depends_on) AND d.status <> 'done'
         )
       ORDER BY t.priority, t.created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING ${COLS}`,
    [workerId],
  );
  const row = r.rows[0] ? norm(r.rows[0]) : undefined;
  if (row) emitEvent({ kind: "task.claimed", agentId: row.agent_id, taskId: row.id, message: `tentative ${row.attempt}/${row.max_attempts}`, data: { worker: workerId } });
  return row;
}

/** Avancement intermédiaire : c'est ce qui permet de reprendre où on en était. */
export async function checkpoint(taskId: number, patch: Record<string, unknown>, message?: string): Promise<void> {
  await db().query(`UPDATE agent_tasks SET checkpoint = checkpoint || $2::jsonb, updated_at=now() WHERE id=$1`, [taskId, JSON.stringify(patch)]);
  if (message) {
    const r = await db().query<{ agent_id: string }>(`SELECT agent_id FROM agent_tasks WHERE id=$1`, [taskId]);
    emitEvent({ kind: "task.progress", agentId: r.rows[0]?.agent_id, taskId, message, data: patch });
  }
}

export async function completeTask(taskId: number, result: string, usd = 0): Promise<void> {
  const r = await db().query<{ agent_id: string }>(
    `UPDATE agent_tasks SET status='done', result=$2, usd=usd+$3, claimed_by=NULL, finished_at=now(), updated_at=now() WHERE id=$1 RETURNING agent_id`,
    [taskId, result.slice(0, 20_000), usd],
  );
  emitEvent({ kind: "task.completed", agentId: r.rows[0]?.agent_id, taskId, message: result.slice(0, 200), data: { usd } });
}

/**
 * Échec. Le statut final dépend du nombre de tentatives : tant qu'il en reste,
 * la tâche retourne en attente et sera reprise ; sinon elle est close en échec.
 * Une tâche `permanent` ne repasse jamais en attente — distinguer une panne
 * passagère d'un refus définitif évite de réessayer trois fois ce qui ne
 * marchera jamais (section 30).
 */
export async function failTask(taskId: number, error: string, opts: { permanent?: boolean; usd?: number } = {}): Promise<TaskStatus> {
  const cur = await db().query<{ attempt: number; max_attempts: number; agent_id: string }>(
    `SELECT attempt, max_attempts, agent_id FROM agent_tasks WHERE id=$1`,
    [taskId],
  );
  const row = cur.rows[0];
  if (!row) return "failed";
  const retry = !opts.permanent && row.attempt < row.max_attempts;
  const status: TaskStatus = retry ? "pending" : "failed";
  await db().query(
    `UPDATE agent_tasks SET status=$2, error=$3, usd=usd+$4, claimed_by=NULL, updated_at=now(),
       finished_at = CASE WHEN $2='failed' THEN now() ELSE NULL END
     WHERE id=$1`,
    [taskId, status, error.slice(0, 4000), opts.usd ?? 0],
  );
  emitEvent({
    kind: retry ? "task.retry" : "task.failed",
    agentId: row.agent_id,
    taskId,
    level: retry ? "warn" : "error",
    message: error.slice(0, 300),
    data: { attempt: row.attempt, max: row.max_attempts, permanent: Boolean(opts.permanent) },
  });
  return status;
}

/** Une tâche qui attend une action humaine (section 9) : ni échec, ni file d'attente. */
export async function blockTask(taskId: number, reason: string): Promise<void> {
  const r = await db().query<{ agent_id: string }>(
    `UPDATE agent_tasks SET status='blocked', error=$2, claimed_by=NULL, updated_at=now() WHERE id=$1 RETURNING agent_id`,
    [taskId, reason.slice(0, 2000)],
  );
  emitEvent({ kind: "task.blocked", agentId: r.rows[0]?.agent_id, taskId, level: "warn", message: reason.slice(0, 300) });
}

export async function unblockTask(taskId: number): Promise<void> {
  const r = await db().query<{ agent_id: string }>(
    `UPDATE agent_tasks SET status='pending', error=NULL, updated_at=now() WHERE id=$1 AND status='blocked' RETURNING agent_id`,
    [taskId],
  );
  if (r.rows[0]) emitEvent({ kind: "task.resumed", agentId: r.rows[0].agent_id, taskId, message: "débloquée par l'opérateur" });
}

/**
 * Reprise au démarrage (section 29).
 *
 * Toute tâche encore 'running' appartient forcément à un processus mort : le
 * nôtre vient de naître et n'a rien réclamé. On les remet en attente — sauf
 * celles qui ont épuisé leurs tentatives, closes en échec avec la raison, pour
 * qu'une tâche qui fait tomber le serveur ne le fasse pas tomber en boucle.
 */
export async function recoverOrphans(): Promise<{ requeued: number; abandoned: number }> {
  const requeue = await db().query<{ id: number; agent_id: string }>(
    `UPDATE agent_tasks SET status='pending', claimed_by=NULL, updated_at=now()
     WHERE status='running' AND attempt < max_attempts RETURNING id, agent_id`,
  );
  const abandon = await db().query<{ id: number; agent_id: string }>(
    `UPDATE agent_tasks SET status='failed', claimed_by=NULL, finished_at=now(), updated_at=now(),
       error = coalesce(error,'') || ' [abandonnée : tentatives épuisées après un redémarrage]'
     WHERE status='running' AND attempt >= max_attempts RETURNING id, agent_id`,
  );
  for (const t of requeue.rows) emitEvent({ kind: "task.resumed", agentId: t.agent_id, taskId: t.id, message: "reprise après redémarrage" });
  for (const t of abandon.rows) emitEvent({ kind: "task.failed", agentId: t.agent_id, taskId: t.id, level: "error", message: "abandonnée après redémarrage (tentatives épuisées)" });
  if (requeue.rowCount || abandon.rowCount) logger.warn({ requeued: requeue.rowCount, abandoned: abandon.rowCount }, "tâches orphelines traitées au démarrage");
  return { requeued: requeue.rowCount ?? 0, abandoned: abandon.rowCount ?? 0 };
}

export async function getTask(id: number): Promise<TaskRow | undefined> {
  const r = await db().query<TaskRow>(`SELECT ${COLS} FROM agent_tasks WHERE id=$1`, [id]);
  return r.rows[0] ? norm(r.rows[0]) : undefined;
}

export async function listTasks(agentId?: string, statuses?: TaskStatus[], limit = 50): Promise<TaskRow[]> {
  const args: unknown[] = [];
  const where: string[] = [];
  if (agentId) { args.push(agentId); where.push(`agent_id=$${args.length}`); }
  if (statuses?.length) { args.push(statuses); where.push(`status = ANY($${args.length})`); }
  args.push(Math.min(limit, 500));
  const r = await db().query<TaskRow>(
    `SELECT ${COLS} FROM agent_tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT $${args.length}`,
    args,
  );
  return r.rows.map(norm);
}
