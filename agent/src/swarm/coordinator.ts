import { config } from "../config.js";
import { runAgent, structured, resolveModelAsync, type Usage } from "../llm.js";
import { logger } from "../logger.js";
import { memoryDigest, agentMemoryRoot, openEpisode, closeEpisode } from "../memory/store.js";
import { ROLES, roleTools, type RoleName } from "./roles.js";

/**
 * Coordinateur d'essaim : PLAN → VAGUES PARALLÈLES → FUSION.
 *
 *   1. Plan : un appel structuré découpe l'objectif en sous-tâches typées par rôle,
 *      avec dépendances explicites (DAG). Pas d'agent « libre » : le plan est un contrat.
 *   2. Exécution : les sous-tâches sans dépendance non résolue partent ensemble
 *      (jusqu'à SWARM_CONCURRENCY). Chaque sous-agent a son rôle, sa mémoire, ses outils,
 *      et — s'il touche du code — SON conteneur sandbox pris dans le pool.
 *   3. Fusion : le coordinateur relit tous les <result>, résout les contradictions,
 *      et produit le livrable final + la liste des actions humaines.
 *
 * VÉRITÉ sur le « ÷10 » : le gain est réel sur le travail parallélisable
 * (10 fournisseurs à relever, 5 articles à écrire, veille sur 8 concurrents).
 * Il est nul sur une chaîne séquentielle (coder → QA → déployer), et les limites
 * de débit API (tokens/min) plafonnent le parallélisme effectif. Mesure : durée
 * de mur et coût par objectif, journalisés dans `episodes`.
 */

export type Subtask = {
  id: string;
  role: RoleName;
  title: string;
  spec: string;
  depends_on: string[];
  acceptance: string[];
};

export type SwarmPlan = { objective: string; subtasks: Subtask[]; merge_instructions: string };

export type SubtaskResult = { id: string; role: RoleName; status: "ok" | "failed" | "budget" | "skipped"; output: string; usage: Usage; seconds: number };

export type SwarmResult = { plan: SwarmPlan; results: SubtaskResult[]; merged: string; totalUsd: number; wallSeconds: number };

const PLAN_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["objective", "subtasks", "merge_instructions"],
    properties: {
      objective: { type: "string" },
      merge_instructions: { type: "string" },
      subtasks: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "role", "title", "spec", "depends_on", "acceptance"],
          properties: {
            id: { type: "string" },
            role: { type: "string", enum: Object.keys(ROLES) },
            title: { type: "string" },
            spec: { type: "string" },
            depends_on: { type: "array", items: { type: "string" } },
            acceptance: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

const PLANNER_SYSTEM = `Tu es le coordinateur d'un essaim d'agents. Découpe l'objectif en sous-tâches indépendantes autant que possible (parallélisme maximal), chacune confiée à UN rôle parmi ceux décrits. Règles :
- Une sous-tâche = un livrable vérifiable + critères d'acceptation concrets.
- Dépendances uniquement quand une sortie est vraiment nécessaire en entrée (ex: qa dépend de coder ; deployer dépend de qa).
- Les rôles code (coder, publisher, qa, deployer) travaillent sur une branche nommée swarm/<date>-<slug> que tu précises dans chaque spec.
- Le spec de chaque sous-tâche doit être auto-suffisant : l'agent ne voit ni l'objectif global ni les autres specs, sauf les résultats de ses dépendances.
- 3 à 10 sous-tâches. Pas plus de 12.`;

export async function planSwarm(objective: string, memory: string): Promise<SwarmPlan> {
  const cfg = config();
  const roles = Object.values(ROLES).map((r) => `- ${r.name}: ${r.description}`).join("\n");
  const { value } = await structured<SwarmPlan>({
    ...(await resolveModelAsync("planner")),
    system: PLANNER_SYSTEM,
    effort: "high",
    schema: PLAN_SCHEMA,
    prompt: `Date: ${new Date().toISOString()}\nRôles disponibles:\n${roles}\n\nOBJECTIF:\n${objective}\n\n<memoire_coordinateur>\n${memory}\n</memoire_coordinateur>`,
  });
  // Validation du DAG : ids uniques, dépendances existantes, pas de cycle.
  const ids = new Set(value.subtasks.map((s) => s.id));
  if (ids.size !== value.subtasks.length) throw new Error("plan invalide : ids dupliqués");
  for (const s of value.subtasks) for (const d of s.depends_on) if (!ids.has(d)) throw new Error(`plan invalide : ${s.id} dépend de ${d} inconnu`);
  topoOrder(value.subtasks); // lève si cycle
  return value;
}

function topoOrder(subtasks: Subtask[]): string[] {
  const indeg = new Map(subtasks.map((s) => [s.id, s.depends_on.length]));
  const order: string[] = [];
  const queue = subtasks.filter((s) => s.depends_on.length === 0).map((s) => s.id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const s of subtasks) if (s.depends_on.includes(id)) {
      indeg.set(s.id, indeg.get(s.id)! - 1);
      if (indeg.get(s.id) === 0) queue.push(s.id);
    }
  }
  if (order.length !== subtasks.length) throw new Error("plan invalide : cycle de dépendances");
  return order;
}

/** Pool de conteneurs sandbox : un agent code attend qu'un conteneur se libère. Sans pool, tous partagent le conteneur par défaut. */
class SandboxPool {
  private free: string[];
  private waiters: Array<(c: string) => void> = [];
  constructor(private readonly names: string[]) {
    this.free = [...names];
  }
  async acquire(): Promise<string | undefined> {
    if (this.names.length === 0) return undefined;
    const c = this.free.shift();
    if (c) return c;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(c: string | undefined) {
    if (!c) return;
    const w = this.waiters.shift();
    if (w) w(c);
    else this.free.push(c);
  }
}

export async function runSwarm(objective: string, opts: { budgetUsd?: number; signal?: AbortSignal } = {}): Promise<SwarmResult> {
  const cfg = config();
  const started = Date.now();
  const episodeId = await openEpisode("swarm", { objective: objective.slice(0, 500) });
  const log = logger.child({ swarm: episodeId });
  const budget = opts.budgetUsd ?? cfg.SWARM_BUDGET_USD;
  const pool = new SandboxPool(cfg.SANDBOX_POOL.split(",").map((s) => s.trim()).filter(Boolean));

  const plan = await planSwarm(objective, await memoryDigest(8_000));
  log.info({ subtasks: plan.subtasks.map((s) => `${s.id}:${s.role}${s.depends_on.length ? `←${s.depends_on.join(",")}` : ""}`) }, "plan");

  const results = new Map<string, SubtaskResult>();
  let spent = 0;
  let running = 0;
  const pending = new Set(plan.subtasks.map((s) => s.id));

  const runOne = async (s: Subtask): Promise<void> => {
    const role = ROLES[s.role];
    const deps = s.depends_on.map((d) => results.get(d)!);
    if (deps.some((d) => d.status !== "ok")) {
      results.set(s.id, { id: s.id, role: s.role, status: "skipped", output: `dépendance en échec: ${deps.filter((d) => d.status !== "ok").map((d) => d.id).join(", ")}`, usage: zeroUsage(), seconds: 0 });
      return;
    }
    if (spent >= budget) {
      results.set(s.id, { id: s.id, role: s.role, status: "skipped", output: "budget d'essaim épuisé", usage: zeroUsage(), seconds: 0 });
      return;
    }
    const container = role.needsSandbox ? await pool.acquire() : undefined;
    const t0 = Date.now();
    const sub = await openEpisode(`swarm:${s.role}`, { parent: episodeId, subtask: s.id, container });
    try {
      const depContext = deps.length
        ? `\n\n<resultats_dependances>\n${deps.map((d) => `## ${d.id} (${d.role})\n${d.output}`).join("\n\n")}\n</resultats_dependances>`
        : "";
      const task = `Date: ${new Date().toISOString()}\nSous-tâche ${s.id} — ${s.title}\n\n${s.spec}\n\nCritères d'acceptation:\n${s.acceptance.map((a) => `- ${a}`).join("\n")}${depContext}\n\n<memoire>\n${await memoryDigest(6_000, agentMemoryRoot(s.role))}\n</memoire>`;
      const res = await runAgent({
        ...(await resolveModelAsync(role.model)),
        system: role.system,
        task,
        tools: roleTools(role, container),
        effort: role.effort,
        maxIterations: role.maxIterations,
        budgetUsd: Math.min(role.budgetUsd, budget - spent),
        signal: opts.signal,
      });
      spent += res.usage.usd;
      const status = res.stopReason === "budget_exceeded" ? "budget" : res.stopReason === "refusal" ? "failed" : "ok";
      const output = extractResult(res.finalText);
      results.set(s.id, { id: s.id, role: s.role, status, output, usage: res.usage, seconds: (Date.now() - t0) / 1000 });
      await closeEpisode(sub, status, output, res.usage);
      log.info({ id: s.id, role: s.role, status, usd: res.usage.usd.toFixed(3), s: Math.round((Date.now() - t0) / 1000) }, "sous-tâche terminée");
    } catch (err) {
      results.set(s.id, { id: s.id, role: s.role, status: "failed", output: String(err).slice(0, 2000), usage: zeroUsage(), seconds: (Date.now() - t0) / 1000 });
      await closeEpisode(sub, "failed", "", zeroUsage(), String(err));
      log.error({ id: s.id, err: String(err) }, "sous-tâche en erreur");
    } finally {
      pool.release(container);
    }
  };

  // Boucle d'ordonnancement : lance tout ce qui est prêt, jusqu'à la concurrence max.
  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (pending.size === 0 && running === 0) return resolve();
      const ready = plan.subtasks.filter((s) => pending.has(s.id) && s.depends_on.every((d) => results.has(d)));
      for (const s of ready) {
        if (running >= cfg.SWARM_CONCURRENCY) break;
        pending.delete(s.id);
        running += 1;
        runOne(s)
          .catch(reject)
          .finally(() => {
            running -= 1;
            tick();
          });
      }
      if (running === 0 && pending.size > 0) reject(new Error("blocage d'ordonnancement (dépendances non satisfiables)"));
    };
    tick();
  });

  // Fusion.
  const ordered = topoOrder(plan.subtasks).map((id) => results.get(id)!);
  const merged = await mergeResults(plan, ordered);
  const totalUsd = ordered.reduce((a, r) => a + r.usage.usd, 0) + 0.05;
  const wallSeconds = (Date.now() - started) / 1000;
  await closeEpisode(episodeId, ordered.every((r) => r.status === "ok") ? "ok" : "failed", merged, {
    ...zeroUsage(),
    usd: totalUsd,
    iterations: ordered.reduce((a, r) => a + r.usage.iterations, 0),
  });
  log.info({ usd: totalUsd.toFixed(2), wall: Math.round(wallSeconds), sequentialEstimate: Math.round(ordered.reduce((a, r) => a + r.seconds, 0)) }, "essaim terminé");
  return { plan, results: ordered, merged, totalUsd, wallSeconds };
}

async function mergeResults(plan: SwarmPlan, results: SubtaskResult[]): Promise<string> {
  const cfg = config();
  const { value } = await structured<{ deliverable: string; human_actions: string[]; open_issues: string[] }>({
    ...(await resolveModelAsync("planner")),
    system: "Tu es le coordinateur. Fusionne les résultats des sous-agents en UN livrable cohérent, résous les contradictions en citant la source la plus fiable, liste les actions qui exigent une validation humaine et les points ouverts. Français, dense.",
    effort: "high",
    schema: {
      type: "json_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["deliverable", "human_actions", "open_issues"],
        properties: { deliverable: { type: "string" }, human_actions: { type: "array", items: { type: "string" } }, open_issues: { type: "array", items: { type: "string" } } },
      },
    },
    prompt: `OBJECTIF: ${plan.objective}\n\nINSTRUCTIONS DE FUSION: ${plan.merge_instructions}\n\n${results.map((r) => `## ${r.id} — ${r.role} — ${r.status} — ${r.usage.usd.toFixed(2)} USD — ${Math.round(r.seconds)}s\n${r.output}`).join("\n\n")}`,
  });
  return `${value.deliverable}\n\n## Actions humaines\n${value.human_actions.map((a) => `- ${a}`).join("\n") || "- (aucune)"}\n\n## Points ouverts\n${value.open_issues.map((a) => `- ${a}`).join("\n") || "- (aucun)"}`;
}

function extractResult(text: string): string {
  const m = text.match(/<result>([\s\S]*?)<\/result>/i);
  return (m?.[1] ?? text).trim().slice(0, 12_000);
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, iterations: 0 };
}
