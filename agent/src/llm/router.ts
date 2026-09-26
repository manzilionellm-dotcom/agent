import { config } from "../config.js";
import { logger } from "../logger.js";
import { runAgent, type AgentRunOptions, type AgentRunResult, type ModelKind, type Provider, type Usage } from "../llm.js";
import { activeProviders, claudeActifSync, recordUsage, type Role } from "../providers.js";

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
  // Claude n'entre dans la chaîne que si Lionel l'a allumé (« active Claude »).
  if (c.ANTHROPIC_API_KEY && claudeActifSync()) {
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

/**
 * Chaîne effective pour un type de tâche, depuis le PANNEAU quand il est
 * rempli, depuis le .env sinon.
 *
 * L'ordre de préférence est celui du panneau (colonne priorité), ce qui rend
 * « mets Mistral devant » ou « mets DeepSeek en pause » immédiats, sans
 * toucher au serveur. Un fournisseur ajouté là n'a pas besoin d'être connu du
 * code : c'est ce qui permet d'en essayer un nouveau le jour où il sort.
 */
export async function routeAsync(kind: ModelKind): Promise<Backend[]> {
  const depuisPanneau = await activeProviders(kind as Role).catch(() => []);
  if (depuisPanneau.length) {
    return depuisPanneau.map((p) => ({
      // Le nom sert aux journaux et à la cascade ; un fournisseur inconnu du
      // code garde simplement son identifiant.
      name: p.id as BackendName,
      provider: p.kind as Provider,
      model: p.model,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
    }));
  }
  return route(kind);
}

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
 * Disjoncteur par cerveau. Mistral a échoué 18 fois sur 19 en une journée :
 * chaque message le tentait d'abord, attendait son échec, puis passait à
 * DeepSeek. Après ÉCHECS_MAX échecs d'affilée, un cerveau sort de la chaîne
 * pour PANNE_MS, sauf s'il est le seul qui reste. Un succès le réarme.
 */
export const ECHECS_MAX = 3;
export const PANNE_MS = 10 * 60_000;
/** Un compte à sec ne se remplit pas en dix minutes : on l'écarte six heures. */
export const SANS_CREDIT_MS = 6 * 60 * 60_000;
const pannes = new Map<string, { echecs: number; jusqua: number; raison: string }>();

/**
 * « 402 Insufficient Balance » (DeepSeek), « insufficient_quota » (OpenAI),
 * « credit balance is too low » (Anthropic) : le compte n'a plus d'argent.
 * Le 25 septembre, quatre conversations ont planté là-dessus, et Lionel a
 * reçu « Je bute sur une erreur interne » au lieu de « recharge DeepSeek ».
 */
export function estSansCredit(err: string): boolean {
  return /\b402\b|insufficient[ _-]?balance|insufficient_quota|credit balance is too low|payment required|exceeded your current quota|billing/i.test(err);
}

type AlerteCredit = (cerveau: string, raison: string) => void | Promise<void>;
let surSansCredit: AlerteCredit | undefined;

/** Branché par index.ts : prévenir Lionel sur WhatsApp. Le routeur ne connaît pas WhatsApp. */
export function quandSansCredit(cb: AlerteCredit): void {
  surSansCredit = cb;
}

export function noterEchec(name: string, raison: string): void {
  const p = pannes.get(name) ?? { echecs: 0, jusqua: 0, raison: "" };
  p.echecs += 1;
  p.raison = raison.slice(0, 160);
  if (estSansCredit(raison)) {
    // Pas besoin d'attendre trois échecs : le quatrième ne trouvera pas plus
    // d'argent sur le compte que le premier.
    const deja = p.jusqua > Date.now();
    p.jusqua = Date.now() + SANS_CREDIT_MS;
    pannes.set(name, p);
    if (!deja) {
      logger.error({ backend: name, raison: p.raison }, "compte sans crédit — cerveau écarté 6 h");
      void Promise.resolve(surSansCredit?.(name, p.raison)).catch(() => undefined);
    }
    return;
  }
  if (p.echecs >= ECHECS_MAX) {
    p.jusqua = Date.now() + PANNE_MS;
    logger.warn({ backend: name, echecs: p.echecs, raison: p.raison }, "cerveau écarté du routage pour 10 minutes");
  }
  pannes.set(name, p);
}

export function noterSucces(name: string): void {
  pannes.delete(name);
}

export function enPanne(name: string): boolean {
  const p = pannes.get(name);
  return Boolean(p && p.jusqua > Date.now());
}

/** Pour le diagnostic : qui est écarté, pourquoi, jusqu'à quand. */
export function etatCerveaux(): Array<{ name: string; echecs: number; ecarte: boolean; raison: string }> {
  return [...pannes.entries()].map(([name, p]) => ({ name, echecs: p.echecs, ecarte: p.jusqua > Date.now(), raison: p.raison }));
}

export function reinitialiserPannes(): void {
  pannes.clear();
}

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
  const complete = await routeAsync(kind);
  if (!complete.length) throw new Error(`aucun modèle configuré pour « ${kind} » — renseigne au moins une clé (MISTRAL_API_KEY, OPENAI_COMPAT_API_KEY, ANTHROPIC_API_KEY)`);
  const valides = complete.filter((b) => !enPanne(b.name));
  const chain = valides.length ? valides : complete;
  if (valides.length < complete.length) logger.info({ kind, ecartes: complete.filter((b) => enPanne(b.name)).map((b) => b.name) }, "cerveaux en panne écartés");

  const attempts: BackendName[] = [];
  let total = ZERO;
  let last: AgentRunResult | undefined;

  for (let i = 0; i < chain.length; i++) {
    const b = chain[i]!;
    attempts.push(b.name);
    const dernier = i === chain.length - 1;
    try {
      const r = await run({ ...opts, kind, provider: b.provider, model: b.model, baseUrl: b.baseUrl, apiKey: b.apiKey });
      total = addUsage(total, r.usage);
      recordUsage({ provider: b.name, model: b.model, kind, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, usd: r.usage.usd, ok: true });
      last = r;
      if (dernier || !shouldEscalate(r)) {
        noterSucces(b.name);
        if (i > 0) logger.info({ kind, backend: b.name, attempts, usd: total.usd.toFixed(4) }, "cascade : repris par le cerveau suivant");
        return { ...r, usage: total, backend: b.name, attempts };
      }
      noterEchec(b.name, `arrêt ${r.stopReason}`);
      logger.warn({ kind, backend: b.name, stop: r.stopReason, suivant: chain[i + 1]?.name }, "cascade : échec, on monte d'un cran");
    } catch (e) {
      recordUsage({ provider: b.name, model: b.model, kind, usd: 0, ok: false });
      noterEchec(b.name, String(e));
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
