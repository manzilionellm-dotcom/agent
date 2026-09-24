import { dansTrace } from "../boite-noire.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { emitEvent } from "../events.js";
import { spentToday } from "../memory/store.js";
import { runMission } from "../missions/index.js";
import { resolveMission } from "../missions/index.js";
import { customToMission } from "../missions/index.js";
import { agentSpend, getAgent, setAgentState, AUTONOMY, type AgentRow } from "./store.js";
import { dailyBudget, testProvider } from "../providers.js";
import { claimNext, completeTask, failTask, blockTask, recoverOrphans, checkpoint, WORKER_ID, type TaskRow } from "./tasks.js";

/**
 * Runtime des agents : la boucle qui fait vivre un agent quand personne ne
 * regarde.
 *
 * Elle ne remplace pas le moteur de missions — elle l'appelle. Une mission
 * reste le savoir-faire ; l'agent est celui qui le porte, avec son identité,
 * son budget et son journal. Réécrire `runMission` aurait jeté neuf missions
 * éprouvées pour la satisfaction d'un schéma neuf.
 *
 * Un seul processus suffit, mais rien n'en interdit plusieurs : la prise de
 * tâche est atomique côté base.
 */

let running = false;
let stopping = false;
let timer: NodeJS.Timeout | undefined;

/** Pause entre deux sondages quand la file est vide. Assez court pour être réactif, assez long pour ne pas marteler Postgres. */
const IDLE_MS = 5_000;

/**
 * Le budget se vérifie AVANT d'exécuter, à trois niveaux : le plafond
 * journalier global, celui de l'agent sur 24 h, et le budget de la tâche.
 * Vérifier après coup revient à constater un dépassement qu'on a payé.
 */
async function budgetBlocked(agent: AgentRow): Promise<{ raison?: string; reste: number }> {
  const [day, plafond] = await Promise.all([spentToday(), dailyBudget()]);
  const mine = await agentSpend(agent.id, 24);
  // Ce qu'une tâche a le droit de dépenser : le plus petit des deux restes.
  const reste = Math.min(plafond - day, agent.daily_usd - mine);
  if (day >= plafond) return { raison: `plafond journalier global atteint (${day.toFixed(2)} / ${plafond} $)`, reste: 0 };
  if (mine >= agent.daily_usd) return { raison: `plafond de l'agent atteint (${mine.toFixed(2)} / ${agent.daily_usd} $ sur 24 h)`, reste: 0 };
  return { reste };
}

/**
 * La clé dont l'agent aura besoin est-elle VALIDE ? Pas « présente » : valide.
 *
 * Coût de la question : un appel HTTP. Coût de ne pas la poser, mesuré sur ce
 * serveur le 22 septembre : un agent censé travailler sur GitHub a tourné
 * 30 tours sans jeton utilisable, brûlé 1,14 $ et rendu un rapport vide — puis
 * a recommencé à l'identique, pour 2,28 $ au total et zéro dépôt traité.
 *
 * Un jeton présent mais refusé passe tous les tests d'existence : c'était
 * exactement le cas ici. Seul un appel réel fait la différence.
 */
const PREVOL_TTL_MS = 5 * 60_000;
const prevol = new Map<string, { at: number; err?: string }>();

export async function outilsIndisponibles(toolset: string): Promise<string | undefined> {
  if (toolset !== "code" && toolset !== "complet") return undefined;
  const cache = prevol.get("github");
  if (cache && Date.now() - cache.at < PREVOL_TTL_MS) return cache.err;
  const t = await testProvider("github").catch(() => undefined);
  // Pas de verdict (service absent du panneau, panne du test) : on laisse
  // passer. Un pré-vol qui bloque sur son propre échec est pire que pas de
  // pré-vol — il arrêterait un agent qui aurait très bien travaillé.
  const err = t && !t.ok ? `GitHub inutilisable : ${t.message} Ajoute ou corrige le jeton sur la page /panel.` : undefined;
  prevol.set("github", { at: Date.now(), err });
  return err;
}

/**
 * Exécute une tâche. Les échecs sont classés (section 30) : ce qui est
 * passager retourne en file, ce qui est définitif s'arrête, et ce qui attend
 * un humain se bloque au lieu de consommer des tentatives pour rien.
 */
async function execute(task: TaskRow): Promise<void> {
  return dansTrace("tache", task.title, () => executeBrut(task));
}

async function executeBrut(task: TaskRow): Promise<void> {
  const agent = await getAgent(task.agent_id);
  if (!agent) {
    await failTask(task.id, `agent ${task.agent_id} introuvable`, { permanent: true });
    return;
  }

  const { raison: blocked, reste } = await budgetBlocked(agent);
  if (blocked) {
    // Un plafond n'est pas un échec de la tâche : elle attend, elle ne brûle
    // pas ses tentatives, et elle repartira quand la fenêtre se rouvrira.
    await blockTask(task.id, blocked);
    await setAgentState(agent.id, "blocked", blocked);
    return;
  }

  if (agent.autonomy <= AUTONOMY.READ_ONLY) {
    await blockTask(task.id, "agent en lecture seule (autonomie 0) : relève son autonomie pour qu'il agisse");
    return;
  }

  // Comme un plafond : une tâche qu'on sait vouée à l'échec attend, elle ne
  // brûle ni son budget ni ses tentatives. Elle repartira seule dès que la
  // clé sera corrigée au panneau.
  const outils = await outilsIndisponibles(agent.toolset);
  if (outils) {
    await blockTask(task.id, outils);
    await setAgentState(agent.id, "blocked", outils);
    return;
  }

  await setAgentState(agent.id, "working", task.title);
  await checkpoint(task.id, { startedAt: new Date().toISOString(), worker: WORKER_ID }, `démarrage : ${task.title}`);

  try {
    // Une tâche peut nommer une mission existante, ou décrire son travail en
    // clair. Dans le second cas on fabrique une mission éphémère à partir de
    // l'agent : même moteur, mêmes garde-fous, aucun chemin d'exécution en
    // double à maintenir.
    const mission = task.mission
      ? await resolveMission(task.mission)
      : customToMission({
          name: `agent_${agent.id}`,
          objective: [agent.mission, agent.instructions, task.brief || task.title].filter(Boolean).join("\n\n"),
          toolset: agent.toolset,
          model: agent.model_kind,
          budget_usd: agent.budget_usd,
          max_iterations: 30,
          allow_irreversible: agent.autonomy >= AUTONOMY.EXTERNAL,
          created_by: agent.created_by,
          created_at: agent.created_at,
        });

    if (!mission) {
      await failTask(task.id, `mission « ${task.mission} » inconnue`, { permanent: true });
      return;
    }

    // Même règle que le planificateur : jamais plus que ce qui reste dans la
    // journée, quel que soit le budget nominal de la mission ou de l'agent.
    const res = await runMission({ ...mission, budgetUsd: Math.min(mission.budgetUsd, agent.budget_usd, reste) }, { brief: task.brief || task.title });
    if (res.status === "ok") {
      await completeTask(task.id, res.text, res.usage.usd);
    } else if (res.status === "budget") {
      await blockTask(task.id, `budget de mission épuisé (${res.usage.usd.toFixed(2)} $)`);
    } else if (!res.text.trim() && res.usage.usd > 0) {
      // Elle a tourné, elle a payé, et elle n'a rien dit. Réessayer à
      // l'identique redonnera le même silence pour le même prix — c'est
      // précisément ce qui a doublé la facture du 22 septembre. On s'arrête
      // et on nomme la dépense, pour qu'elle serve au moins à ça.
      await failTask(
        task.id,
        `${res.usage.iterations} tours, ${res.usage.usd.toFixed(2)} $ dépensés, compte rendu vide. Arrêt sans nouvelle tentative : la relancer telle quelle coûterait autant pour le même résultat. Regarde le journal de l'agent pour voir sur quoi il butait.`,
        { usd: res.usage.usd, permanent: true },
      );
    } else {
      await failTask(task.id, res.text.slice(-1500) || "mission en échec", { usd: res.usage.usd });
    }
  } catch (e) {
    const msg = String(e);
    // Une erreur de permission ou de configuration ne s'arrange pas en
    // réessayant : la retenter deux fois ne fait que doubler le journal.
    const permanent = /permission|unauthorized|forbidden|invalid api key|401|403|introuvable|inconnue/i.test(msg);
    await failTask(task.id, msg.slice(0, 2000), { permanent });
  } finally {
    await setAgentState(agent.id, "idle");
  }
}

/** Un tour de boucle : prend une tâche prête, l'exécute, dit si elle a fait quelque chose. */
export async function tick(): Promise<boolean> {
  const task = await claimNext();
  if (!task) return false;
  await execute(task);
  return true;
}

export function runtimeStarted(): boolean {
  return running;
}

/**
 * Démarre la boucle. À appeler une fois au boot, APRÈS les migrations :
 * `recoverOrphans` écrit dans des tables qui doivent exister.
 */
export async function startRuntime(): Promise<void> {
  if (running) return;
  running = true;
  stopping = false;

  const rec = await recoverOrphans().catch((e) => {
    logger.error({ err: String(e) }, "reprise des tâches orphelines impossible");
    return { requeued: 0, abandoned: 0 };
  });
  emitEvent({ kind: "system.boot", message: `runtime démarré (worker ${WORKER_ID})`, data: rec });
  logger.info({ worker: WORKER_ID, ...rec }, "runtime des agents démarré");

  const loop = async (): Promise<void> => {
    if (stopping) return;
    let worked = false;
    try {
      worked = await tick();
    } catch (e) {
      logger.error({ err: String(e) }, "tour de boucle du runtime en erreur");
    }
    // Enchaîner sans pause tant qu'il y a du travail, souffler sinon.
    timer = setTimeout(() => void loop(), worked ? 50 : IDLE_MS);
  };
  void loop();
}

export function stopRuntime(): void {
  stopping = true;
  running = false;
  if (timer) clearTimeout(timer);
}
