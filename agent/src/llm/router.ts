import { config } from "../config.js";
import { logger } from "../logger.js";
import { runAgent, type AgentRunOptions, type AgentRunResult, type ModelKind, type Provider, type Usage } from "../llm.js";

/**
 * Routeur à trois cerveaux.
 *
 *   mistral   — français, conversation, tâches courantes
 *   deepseek  — code, calcul, raisonnement structuré, pas cher
 *   claude    — ce qui écrit du code en production et ce qui est vraiment dur
 *
 * DEUX COUCHES, et la distinction est ce qui fait l'économie :
 *
 * 1. Le ROUTAGE choisit d'avance selon la nature de la tâche. C'est lui qui
 *    fait baisser la facture, parce qu'il ne paie qu'un modèle.
 *
 * 2. La CASCADE ne rattrape qu'un ÉCHEC — exception, refus, boucle détectée,
 *    réponse vide. Pas « une hésitation » : un modèle qui hésite rend une
 *    réponse comme les autres, et la seule façon de le savoir est de faire
 *    relire par un juge, qui coûte souvent le prix du meilleur modèle. On ne
 *    devine donc pas la qualité ; on constate les pannes.
 *
 * Ce qu'une cascade coûte, à savoir avant de l'élargir : un échec au tour 12
 * d'une boucle agentique fait tout recommencer au modèle suivant. On paie les
 * deux. C'est indolore sur les tâches faciles et cher sur les tâches dures —
 * exactement celles où le routage aurait dû viser juste du premier coup.
 */

export type BackendName = "mistral" | "deepseek" | "claude";

export type Backend = {
  name: BackendName;
  provider: Provider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
};

/** Les cerveaux réellement utilisables : une clé absente retire le backend du routage. */
export function backends(): Partial<Record<BackendName, Backend>> {
  const c = config();
  const out: Partial<Record<BackendName, Backend>> = {};
  if (c.MISTRAL_API_KEY) {
    out.mistral = { name: "mistral", provider: "openai_compat", model: c.MODEL_MISTRAL, baseUrl: c.MISTRAL_BASE_URL, apiKey: c.MISTRAL_API_KEY };
  }
  if (c.OPENAI_COMPAT_API_KEY && c.OPENAI_COMPAT_BASE_URL) {
    out.deepseek = { name: "deepseek", provider: "openai_compat", model: c.MODEL_WORKER, baseUrl: c.OPENAI_COMPAT_BASE_URL, apiKey: c.OPENAI_COMPAT_API_KEY };
  }
  if (c.ANTHROPIC_API_KEY) {
    out.claude = { name: "claude", provider: "anthropic", model: c.MODEL_CRITICAL ?? "claude-sonnet-5" };
  }
  return out;
}

/**
 * Chaînes par défaut. `critical` ne cascade pas : cette catégorie écrit du code
 * et le déploie, et une reprise par un modèle plus faible produirait un push
 * qu'il faudrait défaire. Un plafond de qualité s'y justifie ; une économie non.
 */
const DEFAULT_ROUTES: Record<ModelKind, BackendName[]> = {
  chat: ["mistral", "deepseek", "claude"],
  worker: ["mistral", "deepseek"],
  planner: ["deepseek", "claude"],
  critical: ["claude"],
};

const ROUTE_ENV: Record<ModelKind, "ROUTE_CHAT" | "ROUTE_WORKER" | "ROUTE_PLANNER" | "ROUTE_CRITICAL"> = {
  chat: "ROUTE_CHAT",
  worker: "ROUTE_WORKER",
  planner: "ROUTE_PLANNER",
  critical: "ROUTE_CRITICAL",
};

const KNOWN: BackendName[] = ["mistral", "deepseek", "claude"];

/** Chaîne effective pour un type de tâche : ce que dit le .env, réduit à ce qui est configuré. */
export function route(kind: ModelKind): Backend[] {
  const avail = backends();
  const raw = config()[ROUTE_ENV[kind]];
  let wanted: BackendName[];
  if (raw) {
    const noms = raw.split(">").map((s) => s.trim().toLowerCase()).filter(Boolean);
    // Une faute de frappe — « deepsek » — retirerait un cerveau de la chaîne
    // sans rien dire, et la facture partirait chez le suivant sans explication.
    const inconnus = noms.filter((n) => !(KNOWN as string[]).includes(n));
    if (inconnus.length) logger.warn({ kind, inconnus, connus: KNOWN }, `${ROUTE_ENV[kind]} : nom(s) de cerveau inconnu(s), ignoré(s)`);
    wanted = noms.filter((n): n is BackendName => (KNOWN as string[]).includes(n));
  } else {
    wanted = DEFAULT_ROUTES[kind];
  }
  const chain = wanted.map((n) => avail[n]).filter((b): b is Backend => Boolean(b));
  // Rien de la chaîne n'est configuré : on prend ce qui existe, dans l'ordre de
  // préférence général. Mieux vaut un modèle inattendu qu'un agent muet.
  return chain.length ? chain : KNOWN.map((n) => avail[n]).filter((b): b is Backend => Boolean(b));
}

/**
 * Un échec qui justifie de passer au cerveau suivant.
 *
 * `budget_exceeded` n'en est pas un : c'est un plafond voulu, et recommencer
 * ailleurs le dépasserait deux fois. `timeout` non plus : le modèle suivant
 * mettrait le même temps, pour le même mur. Une boucle détectée, en revanche,
 * est bien le symptôme d'un modèle dépassé par la tâche.
 */
function shouldEscalate(r: AgentRunResult): boolean {
  if (r.stopReason === "refusal" || r.stopReason === "loop_detected") return true;
  return !r.finalText.trim();
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    usd: a.usd + b.usd,
    iterations: a.iterations + b.iterations,
  };
}

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, iterations: 0 };

export type RoutedResult = AgentRunResult & { backend: BackendName; attempts: BackendName[] };

/**
 * Exécute une tâche sur la chaîne du type demandé, en montant d'un cran à
 * chaque échec. L'usage renvoyé est CUMULÉ sur toutes les tentatives : une
 * cascade qui ne compterait que la dernière mentirait sur son coût, et c'est
 * précisément le coût qu'il faut surveiller ici.
 */
export async function runRouted(
  kind: ModelKind,
  opts: Omit<AgentRunOptions, "model" | "provider" | "baseUrl" | "apiKey">,
  // Injectable pour les tests : une cascade ne se vérifie qu'en provoquant des
  // échecs, et les provoquer sur de vraies API coûterait de l'argent à chaque
  // exécution de la suite.
  run: (o: AgentRunOptions) => Promise<AgentRunResult> = runAgent,
): Promise<RoutedResult> {
  const chain = route(kind);
  if (!chain.length) throw new Error(`aucun modèle configuré pour « ${kind} » — renseigne au moins une clé (MISTRAL_API_KEY, OPENAI_COMPAT_API_KEY, ANTHROPIC_API_KEY)`);

  const attempts: BackendName[] = [];
  let total = ZERO;
  let last: AgentRunResult | undefined;

  for (let i = 0; i < chain.length; i++) {
    const b = chain[i]!;
    attempts.push(b.name);
    const dernier = i === chain.length - 1;
    try {
      const r = await run({ ...opts, provider: b.provider, model: b.model, baseUrl: b.baseUrl, apiKey: b.apiKey });
      total = addUsage(total, r.usage);
      last = r;
      if (dernier || !shouldEscalate(r)) {
        if (i > 0) logger.info({ kind, backend: b.name, attempts, usd: total.usd.toFixed(4) }, "cascade : repris par le cerveau suivant");
        return { ...r, usage: total, backend: b.name, attempts };
      }
      logger.warn({ kind, backend: b.name, stop: r.stopReason, suivant: chain[i + 1]?.name }, "cascade : échec, on monte d'un cran");
    } catch (e) {
      logger.warn({ kind, backend: b.name, err: String(e).slice(0, 200), suivant: chain[i + 1]?.name }, "cascade : exception, on monte d'un cran");
      // Le dernier de la chaîne : plus personne derrière, l'erreur remonte.
      if (dernier) throw e;
    }
  }

  // Inatteignable en pratique (la boucle renvoie ou jette au dernier tour),
  // mais TypeScript ne le sait pas, et un `!` ici cacherait une vraie
  // régression le jour où la boucle changera.
  if (!last) throw new Error(`cascade « ${kind} » : aucune tentative n'a abouti`);
  return { ...last, usage: total, backend: attempts[attempts.length - 1]!, attempts };
}
