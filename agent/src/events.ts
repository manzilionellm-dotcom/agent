import { EventEmitter } from "node:events";
import { db } from "./memory/db.js";
import { logger } from "./logger.js";

/**
 * Bus d'événements (section 17) et journal d'activité (section 23) : une
 * seule table, un seul chemin d'écriture.
 *
 * Les séparer aurait donné deux vérités sur ce qui s'est passé — le bus dit
 * une chose, la timeline une autre, et on ne sait plus laquelle croire quand
 * elles divergent. Ici tout événement est persisté ET diffusé : la timeline
 * est une lecture de la table, l'abonnement une écoute du même flux.
 *
 * L'écriture en base ne bloque JAMAIS l'appelant et n'échoue jamais bruyamment :
 * un journal qui fait tomber la tâche qu'il observe est pire que pas de journal.
 */

export type EventKind =
  | "agent.created" | "agent.updated" | "agent.deleted" | "agent.state"
  | "task.created" | "task.claimed" | "task.progress" | "task.completed"
  | "task.failed" | "task.retry" | "task.blocked" | "task.resumed"
  | "routine.started" | "routine.completed"
  | "approval.requested" | "approval.decided"
  | "memory.created" | "skill.created" | "skill.updated"
  | "vault.stored" | "vault.forgotten"
  | "system.boot" | "system.alert";

export type AgentEvent = {
  kind: EventKind;
  agentId?: string;
  taskId?: number;
  level?: "info" | "warn" | "error";
  message?: string;
  data?: Record<string, unknown>;
};

/** Bus en mémoire : les modules du même processus réagissent sans interroger la base. */
const bus = new EventEmitter();
bus.setMaxListeners(50);

export function onEvent(kind: EventKind | "*", fn: (e: AgentEvent & { ts: Date }) => void): () => void {
  bus.on(kind, fn);
  return () => void bus.off(kind, fn);
}

export function emitEvent(e: AgentEvent): void {
  const full = { ...e, ts: new Date() };
  bus.emit(e.kind, full);
  bus.emit("*", full);
  // Le `void` est délibéré : l'appelant continue pendant l'écriture.
  void db()
    .query(
      `INSERT INTO events(kind, agent_id, task_id, level, message, data) VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.kind, e.agentId ?? null, e.taskId ?? null, e.level ?? "info", (e.message ?? "").slice(0, 2000), JSON.stringify(e.data ?? {})],
    )
    .catch((err) => logger.warn({ err: String(err), kind: e.kind }, "événement non journalisé"));
}

export type TimelineRow = { id: number; kind: string; level: string; message: string; data: Record<string, unknown>; ts: string; task_id: number | null };

/** La timeline d'un agent : ce que l'opérateur lit pour savoir ce que fait son agent. */
export async function timeline(agentId: string, limit = 50): Promise<TimelineRow[]> {
  const r = await db().query<TimelineRow>(
    `SELECT id, kind, level, message, data, ts, task_id FROM events WHERE agent_id=$1 ORDER BY ts DESC LIMIT $2`,
    [agentId, Math.min(limit, 500)],
  );
  return r.rows.reverse();
}
