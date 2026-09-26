/**
 * Aiguillage : pour chaque message, le type de travail, et le modèle le plus
 * fort pour ce type — les gratuits d'abord.
 *
 * Demande de Lionel (26/09) : « choisis le meilleur modèle gratuit selon le
 * type de travail — code, raisonnement, écriture, traduction, analyse —,
 * explique brièvement ton choix, et si un modèle échoue passe au suivant ».
 * Le passage au suivant existait (router.runRouted) ; ce module ajoute le
 * choix.
 *
 * Choix de conception :
 *   - Le type se devine par mots-clés, SANS appel de modèle : un classement
 *     par IA coûterait un appel de plus à chaque message, pour un gain faible
 *     — la plupart des demandes disent ce qu'elles veulent (« traduis »,
 *     « corrige ce bug », « rédige »). Un message ambigu reste « général » et
 *     garde l'ordre du panneau.
 *   - Les forces d'un modèle se lisent dans son NOM (codestral → code,
 *     gemini → traduction…) ou dans sa note au panneau (« forces : code,
 *     traduction »), qui prime : Lionel peut corriger sans toucher au code.
 *   - « Gratuit » se lit dans la note (« gratuit »), ou se déduit des offres
 *     gratuites connues : modèles « :free » d'OpenRouter, Gemini par Google AI
 *     Studio. On ne devine pas pour Mistral : son offre gratuite existe, mais
 *     rien ne dit si LE compte branché est gratuit.
 *   - Réordonner, jamais retirer (sauf mode « seulement ») : un modèle fort
 *     mais payant reste en secours derrière les gratuits. Un bot muet parce
 *     que tous les gratuits sont à leur limite du jour serait pire.
 */

export const TYPES = ["code", "raisonnement", "ecriture", "traduction", "analyse", "general"] as const;
export type TypeTache = (typeof TYPES)[number];

export const LIBELLES: Record<TypeTache, string> = {
  code: "code",
  raisonnement: "raisonnement",
  ecriture: "écriture",
  traduction: "traduction",
  analyse: "analyse",
  general: "conversation",
};

/** Ordre voulu : « traduis ce mail » est une traduction, « écris un script » est du code. */
/**
 * Un motif « mot entier » qui connaît les lettres accentuées. Le \b de
 * JavaScript ne connaît que [A-Za-z0-9_] : « Översätt » ou « écris » en début
 * de mot n'étaient jamais reconnus.
 */
function mot(alternatives: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");
}

const MOTS: Array<[TypeTache, RegExp]> = [
  ["traduction", mot(String.raw`tradui[st]?|traduction|translate|översätt|en (anglais|suédois|français|arabe|espagnol|allemand|chinois|polonais|kinyarwanda)|in english|på svenska|på engelska`)],
  ["code", mot(String.raw`code|coder|codé|bug|script|fonction|python|javascript|typescript|html|css|sql|regex|api|github|dépôt|depot|repo|next\.?js|react|compile|build|déploie|deploie|pull request|commit|cursor`)],
  ["raisonnement", mot(String.raw`calcule|combien (ça|ca|cela) (fait|coûte|coute)|pourquoi|prouve|logique|probabilité|équation|maths?|stratégie|meilleur choix|décide|plan d'action|raisonne|rentable|marge|bénéfice`)],
  ["analyse", mot(String.raw`analyse|analyser|résume|resume|synthèse|extrais|rapport|données|tableau|csv|excel|pdf|compare|comparatif|avis sur|audit`)],
  ["ecriture", mot(String.raw`écris|ecris|rédige|redige|article|annonce|description|e-?mail|lettre|post|publication|texte|slogan|titre|bio|légende|caption`)],
];

export function classer(message: string): TypeTache {
  const t = message.slice(0, 2_000);
  for (const [type, re] of MOTS) if (re.test(t)) return type;
  return "general";
}

/** Forces connues, par motif de nom de modèle. La première qui correspond gagne. */
const FORCES: Array<[RegExp, TypeTache[]]> = [
  [/codestral|devstral|coder|north-mini-code|laguna/i, ["code"]],
  [/deepseek-v4-pro|reasoner|\br1\b|qwq|inkling|reasoning|nemotron-3-ultra/i, ["raisonnement", "code", "analyse"]],
  [/deepseek/i, ["code", "raisonnement", "analyse"]],
  [/gemini|gemma/i, ["traduction", "analyse", "ecriture"]],
  [/magistral/i, ["raisonnement", "ecriture"]],
  [/mistral|mixtral/i, ["ecriture", "traduction"]],
  [/qwen/i, ["code", "traduction", "raisonnement"]],
  [/gpt-oss|nemotron/i, ["raisonnement", "code"]],
  [/claude|opus|sonnet/i, ["code", "raisonnement", "ecriture", "analyse"]],
  [/grok/i, ["raisonnement", "ecriture"]],
  [/glm/i, ["code", "raisonnement"]],
  [/llama/i, ["ecriture"]],
];

export type Candidat = { name: string; model: string; baseUrl?: string; note?: string; label?: string };

export function forces(c: Candidat): TypeTache[] {
  const note = /forces?\s*:\s*([^·|;\n]+)/i.exec(c.note ?? "")?.[1];
  if (note) {
    const liste = note.split(/[,/ ]+/).map((s) => s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")).filter(Boolean);
    const vus = TYPES.filter((t) => liste.includes(t));
    if (vus.length) return vus;
  }
  return FORCES.find(([re]) => re.test(c.model))?.[1] ?? [];
}

export function estGratuit(c: Candidat): boolean {
  if (/\bpayant\b/i.test(c.note ?? "")) return false;
  if (/\bgratuit/i.test(c.note ?? "")) return true;
  if (/:free$/i.test(c.model) || c.model === "openrouter/free") return true;
  return /generativelanguage\.googleapis\.com/i.test(c.baseUrl ?? "");
}

export type ModeGratuit = "off" | "dabord" | "seulement";

/**
 * L'ordre d'essai. Clé de tri, du plus au moins important :
 *   1. gratuit avant payant (modes « dabord » et « seulement ») ;
 *   2. fort pour ce type avant les autres ;
 *   3. l'ordre du panneau (priorité), conservé à égalité.
 */
export function ordonner<T extends Candidat>(chaine: T[], type: TypeTache, mode: ModeGratuit): T[] {
  let base = chaine;
  if (mode === "seulement") {
    const gratuits = chaine.filter(estGratuit);
    if (gratuits.length) base = gratuits;
  }
  const cle = (c: T): number => (mode !== "off" && !estGratuit(c) ? 2 : 0) + (type !== "general" && !forces(c).includes(type) ? 1 : 0);
  return base.map((c, i) => ({ c, i, k: cle(c) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.c);
}

/** Le nom lisible d'un modèle, pour l'explication. */
export function nomLisible(c: Candidat): string {
  const l = (c.label ?? "").replace(/\s*\((gratuit|free)\)\s*/i, "").trim();
  return l || c.name;
}

/** La ligne d'explication : « 🧠 Gemini Flash (gratuit) · traduction ». */
export function explication(essais: Candidat[], retenu: Candidat, type: TypeTache): string {
  const qui = `${nomLisible(retenu)}${estGratuit(retenu) ? " (gratuit)" : ""}`;
  const pourquoi = type !== "general" && forces(retenu).includes(type) ? ` · fort en ${LIBELLES[type]}` : type !== "general" ? ` · ${LIBELLES[type]}` : "";
  const avant = essais.filter((e) => e.name !== retenu.name).map(nomLisible);
  return `🧠 ${qui}${pourquoi}${avant.length ? ` (après échec de ${avant.join(", ")})` : ""}`;
}

/** Offres gratuites prêtes à remplir au panneau. Les noms de modèles se vérifient par « Tester la clé ». */
export const PRESETS: Record<string, { id: string; label: string; baseUrl: string; model: string; note: string; priority: number; ou: string }> = {
  gemini: {
    id: "gemini",
    label: "Gemini Flash (gratuit)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    note: "gratuit · forces : traduction, analyse, ecriture",
    priority: 15,
    ou: "aistudio.google.com → Get API key → Create API key",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (gratuit)",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
    note: "gratuit · forces : code, raisonnement",
    priority: 16,
    ou: "openrouter.ai → Keys → Create Key",
  },
};
