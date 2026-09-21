import { db } from "../memory/db.js";

/**
 * Missions définies par l'opérateur.
 *
 * Les neuf missions de `index.ts` sont écrites en TypeScript : les modifier
 * demande de recompiler et redéployer. Celles-ci vivent en base, se créent
 * depuis WhatsApp en une phrase, et sont exécutées par exactement le même
 * moteur — mêmes garde-fous, même budget, même juge de vérification.
 *
 * Ce module ne connaît que la base. La conversion en `Mission` est faite par
 * `index.ts`, qui détient les outils : cela évite une dépendance circulaire.
 */

export const TOOLSETS = ["recherche", "code", "complet"] as const;
export type Toolset = (typeof TOOLSETS)[number];

export const MODELS = ["planner", "worker", "critical"] as const;
export type ModelKind = (typeof MODELS)[number];

export type CustomMissionRow = {
  name: string;
  objective: string;
  toolset: Toolset;
  model: ModelKind;
  budget_usd: number;
  max_iterations: number;
  allow_irreversible: boolean;
  created_by: string;
  created_at: string;
};

/** Un nom de mission sert d'identifiant en base, en CLI et dans les crons. */
export const NAME_RE = /^[a-z][a-z0-9_]{2,39}$/;

type Row = Omit<CustomMissionRow, "budget_usd" | "max_iterations"> & { budget_usd: string; max_iterations: number };

// `numeric` revient en chaîne avec node-postgres : on normalise ici plutôt que
// de laisser un budget « 1.50 » se comparer comme du texte ailleurs.
const parse = (r: Row): CustomMissionRow => ({ ...r, budget_usd: Number(r.budget_usd), max_iterations: Number(r.max_iterations) });

export async function listCustomMissions(): Promise<CustomMissionRow[]> {
  const r = await db().query<Row>(`SELECT * FROM custom_missions ORDER BY name`);
  return r.rows.map(parse);
}

export async function getCustomMission(name: string): Promise<CustomMissionRow | undefined> {
  const r = await db().query<Row>(`SELECT * FROM custom_missions WHERE name = $1`, [name]);
  return r.rows[0] ? parse(r.rows[0]) : undefined;
}

export async function saveCustomMission(m: {
  name: string;
  objective: string;
  toolset?: Toolset;
  model?: ModelKind;
  budgetUsd?: number;
  maxIterations?: number;
  allowIrreversible?: boolean;
  createdBy: string;
}): Promise<void> {
  await db().query(
    `INSERT INTO custom_missions (name, objective, toolset, model, budget_usd, max_iterations, allow_irreversible, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (name) DO UPDATE SET
       objective = EXCLUDED.objective,
       toolset = EXCLUDED.toolset,
       model = EXCLUDED.model,
       budget_usd = EXCLUDED.budget_usd,
       max_iterations = EXCLUDED.max_iterations,
       allow_irreversible = EXCLUDED.allow_irreversible,
       updated_at = now()`,
    [
      m.name,
      m.objective,
      m.toolset ?? "recherche",
      m.model ?? "worker",
      m.budgetUsd ?? 1.0,
      m.maxIterations ?? 30,
      m.allowIrreversible ?? false,
      m.createdBy,
    ],
  );
}

export async function deleteCustomMission(name: string): Promise<boolean> {
  const r = await db().query(`DELETE FROM custom_missions WHERE name = $1`, [name]);
  return (r.rowCount ?? 0) > 0;
}
