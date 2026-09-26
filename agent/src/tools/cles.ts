import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getProvider, putProvider, testProvider } from "../providers.js";
import { PRESETS } from "../llm/aiguillage.js";
import { runBctl } from "./browser.js";
import { empreinte } from "./masque-cles.js";

/**
 * Le bot crée lui-même ses clés d'API — sans jamais les voir.
 *
 * Lionel : « dis à Manzi d'aller créer ses applis, il a accès à mon e-mail ».
 * Le compte Google est connecté dans le navigateur du serveur : le bot peut
 * ouvrir la page des clés et cliquer « Créer ». Le danger est la suite : la
 * clé s'affiche, et un modèle qui la LIT l'a dans son contexte — envoyé à un
 * fournisseur, parfois gratuit et qui entraîne sur ses échanges.
 *
 * Ici, c'est le CODE qui lit la clé dans la page (action « cles » du démon),
 * la vérifie, la range chiffrée au panneau et la teste. Le modèle ne reçoit
 * que « clé Gemini enregistrée, elle finit par …a1b2 ». Même principe que le
 * coffre, dans l'autre sens.
 *
 * Garde-fous :
 *   - Motif exact par service (AIza… pour Gemini, sk-or-v1-… pour
 *     OpenRouter) : rien d'autre n'est capturé.
 *   - La page doit être sur le domaine du service. Sinon une page piégée
 *     pourrait afficher la clé d'un inconnu : le bot l'enregistrerait, et
 *     tes conversations partiraient sur le compte de l'inconnu.
 *   - Une seule clé visible, sinon on ne choisit pas au hasard.
 */

type Service = { preset?: keyof typeof PRESETS; id: string; label: string; page: string; domaine: RegExp; motif: string; baseUrl: string; model: string; note: string; priority: number; etapes: string };

export const SERVICES_CLES: Record<string, Service> = {
  gemini: {
    preset: "gemini", id: "gemini", label: PRESETS.gemini!.label, page: "https://aistudio.google.com/apikey", domaine: /(^|\.)aistudio\.google\.com$/i,
    motif: "AIza[0-9A-Za-z_\\-]{35}(?![0-9A-Za-z_\\-])", baseUrl: PRESETS.gemini!.baseUrl, model: PRESETS.gemini!.model, note: PRESETS.gemini!.note, priority: PRESETS.gemini!.priority,
    etapes: "goto https://aistudio.google.com/apikey → click « Create API key » (ou « Créer une clé API ») → si on te demande un projet, choisis le premier ou « Create API key in new project » → attends que la clé s'affiche",
  },
  openrouter: {
    preset: "openrouter", id: "openrouter", label: PRESETS.openrouter!.label, page: "https://openrouter.ai/settings/keys", domaine: /(^|\.)openrouter\.ai$/i,
    motif: "sk-or-v1-[0-9a-f]{64}(?![0-9a-f])", baseUrl: PRESETS.openrouter!.baseUrl, model: PRESETS.openrouter!.model, note: PRESETS.openrouter!.note, priority: PRESETS.openrouter!.priority,
    etapes: "goto https://openrouter.ai/settings/keys (si pas connecté : « Sign in » → « Continue with Google ») → click « Create Key » → nom « manzi » → « Create » → attends que la clé s'affiche",
  },
  groq: {
    id: "groq-llm", label: "Groq (gratuit)", page: "https://console.groq.com/keys", domaine: /(^|\.)console\.groq\.com$/i,
    motif: "gsk_[A-Za-z0-9]{40,64}(?![A-Za-z0-9])", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", note: "gratuit · forces : raisonnement, code", priority: 40,
    etapes: "goto https://console.groq.com/keys → click « Create API Key » → nom « manzi » → « Submit » → attends que la clé s'affiche",
  },
  deepseek: {
    id: "deepseek", label: "DeepSeek", page: "https://platform.deepseek.com/api_keys", domaine: /(^|\.)platform\.deepseek\.com$/i,
    motif: "sk-[0-9a-f]{32}(?![0-9a-f])", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", note: "payant · forces : code, raisonnement, analyse", priority: 20,
    etapes: "goto https://platform.deepseek.com/api_keys → click « Create new API key » → nom « manzi » → « Create » → attends que la clé s'affiche",
  },
};

export type Capture = { ok: true; service: string; fin: string; test: string; testOk: boolean } | { ok: false; raison: string };

/**
 * Lit la clé dans la page, la range, la teste. `lire` est injectable pour
 * les tests : il rend l'adresse de la page et les clés trouvées.
 */
export async function capturerCle(nom: string, lire: (motif: string) => Promise<{ url: string; cles: string[] } | string>): Promise<Capture> {
  const s = SERVICES_CLES[nom];
  if (!s) return { ok: false, raison: `service inconnu : ${nom} (connus : ${Object.keys(SERVICES_CLES).join(", ")})` };
  const lu = await lire(s.motif);
  if (typeof lu === "string") return { ok: false, raison: lu.slice(0, 300) };
  let hote = "";
  try { hote = new URL(lu.url).hostname; } catch { /* adresse illisible */ }
  if (!s.domaine.test(hote)) return { ok: false, raison: `la page ouverte est ${hote || lu.url}, pas le site de ${s.label} : je ne capture une clé que sur ${s.page}` };
  const cles = [...new Set(lu.cles)];
  if (!cles.length) return { ok: false, raison: `aucune clé ${s.label} visible sur la page. Clique d'abord « Create » et attends qu'elle s'affiche (certains sites ne la montrent qu'une fois).` };
  if (cles.length > 1) return { ok: false, raison: `${cles.length} clés visibles sur la page (${cles.map(empreinte).join(", ")}) : ouvre seulement la nouvelle, ou ferme les autres, puis recommence` };
  const cle = cles[0]!;
  const existant = await getProvider(s.id).catch(() => undefined);
  await putProvider(
    existant
      ? { id: s.id, category: existant.category, label: existant.label, kind: existant.kind, baseUrl: existant.base_url, model: existant.model, apiKey: cle, enabled: true, priority: existant.priority, roles: existant.roles.split(","), dailyCapUsd: Number(existant.daily_cap_usd), note: existant.note }
      : { id: s.id, category: "modele", label: s.label, kind: "openai_compat", baseUrl: s.baseUrl, model: s.model, apiKey: cle, enabled: true, priority: s.priority, roles: ["chat", "worker"], note: s.note },
  );
  const t = await testProvider(s.id).catch((e) => ({ ok: false, message: String(e).slice(0, 200) }));
  logger.info({ service: s.id, fin: empreinte(cle), test: t.ok }, "clé capturée dans la page et rangée au panneau");
  return { ok: true, service: s.label, fin: empreinte(cle), test: t.message.split(cle).join(empreinte(cle)), testOk: t.ok };
}

export function outilCle() {
  return betaZodTool({
    name: "enregistrer_cle_affichee",
    description:
      `Quand Lionel te dit de créer toi-même une clé d'API (« va créer ta clé Gemini », « crée ta clé OpenRouter »), fais-le dans le navigateur, puis appelle CET outil : il lit la clé dans la page, la range chiffrée au panneau et la teste — tu ne la vois jamais, et tu ne dois jamais essayer de la lire, la recopier ou la taper. Étapes par service : ${Object.entries(SERVICES_CLES).map(([k, s]) => `${k} : ${s.etapes}`).join(" ; ")}. Captcha, code SMS ou mot de passe demandé : tu t'arrêtes et tu appelles demande_connexion.`,
    inputSchema: z.object({ service: z.enum(Object.keys(SERVICES_CLES) as [string, ...string[]]) }),
    run: async (i) => {
      const cfg = config();
      const r = await capturerCle(i.service, async (motif) => {
        const out = await runBctl("cles", JSON.stringify({ motif }), undefined, cfg.BROWSER_CDP_URL, true);
        if (typeof out === "string") return out;
        if (!out.ok) return `Error: ${String(out.error ?? "lecture de la page impossible")}`;
        return { url: String(out.url ?? ""), cles: Array.isArray(out.cles) ? (out.cles as string[]) : [] };
      });
      if (!r.ok) return `Error: ${r.raison}`;
      return `clé ${r.service} enregistrée au panneau (elle finit par ${r.fin}). Test : ${r.testOk ? "OK" : "ÉCHEC"} — ${r.test}. Dis-le à Lionel en une ligne, avec la fin de la clé, jamais plus.`;
    },
  });
}
