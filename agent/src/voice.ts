import { logger } from "./logger.js";
import { getProvider, setting } from "./providers.js";
import { decryptSecret } from "./vault.js";
import { sendWhatsApp, sendWhatsAppAudio } from "./channels/whatsapp.js";

/**
 * La voix de l'agent : il répond en note vocale sur WhatsApp.
 *
 * Le fournisseur se branche au panneau comme n'importe quelle clé — un
 * service nommé `voix`, catégorie « Autres », type compatible OpenAI. Tout
 * endpoint qui expose `POST /audio/speech` au format OpenAI convient
 * (OpenAI lui-même, et les serveurs qui en copient l'API). Rien n'est
 * codé en dur : changer de voix ou de fournisseur se fait sur la page.
 *
 * Trois modes :
 *   off       — texte seulement (défaut : une installation neuve ne se met
 *               pas à parler toute seule, ni à facturer une synthèse) ;
 *   si_vocal  — il répond en vocal quand Lionel lui a parlé en vocal ;
 *   toujours  — chaque réponse part aussi en vocal.
 *
 * Le texte part quand même par défaut, et TOUJOURS quand la réponse contient
 * un lien : un lien lu à voix haute ne se clique pas.
 */

export const VOIX_MODES = { off: "Jamais", si_vocal: "Quand je lui parle en vocal", toujours: "Toujours" } as const;
export type VoixMode = keyof typeof VOIX_MODES;

export type VoixReglages = { mode: VoixMode; nom: string; consignes: string; texteAussi: boolean };

/** OpenAI plafonne l'entrée à 4 096 caractères ; au-delà d'une minute, personne n'écoute une note vocale. */
const MAX_PAROLE = 900;

export async function voixReglages(): Promise<VoixReglages> {
  const [mode, nom, consignes, texte] = await Promise.all(["VOIX_MODE", "VOIX_NOM", "VOIX_CONSIGNES", "VOIX_TEXTE_AUSSI"].map((k) => setting(k).catch(() => undefined)));
  return {
    mode: mode && mode in VOIX_MODES ? (mode as VoixMode) : "off",
    nom: nom?.trim() || "onyx",
    consignes: consignes?.trim().slice(0, 600) ?? "",
    texteAussi: texte !== "off",
  };
}

/**
 * Prépare un texte écrit pour être DIT.
 *
 * Le markdown se lit littéralement (« astérisque astérisque »), une URL se lit
 * caractère par caractère pendant trente secondes. On les retire, et on coupe
 * à une frontière de phrase pour ne pas finir au milieu d'un mot.
 */
export function pourLaVoix(texte: string): string {
  let t = texte
    .replace(/https?:\/\/\S+/g, "le lien est dans le message")
    .replace(/[*_`#>|]/g, "")
    .replace(/^\s*[-•·]\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (t.length > MAX_PAROLE) {
    const coupe = t.slice(0, MAX_PAROLE);
    const fin = Math.max(coupe.lastIndexOf(". "), coupe.lastIndexOf("! "), coupe.lastIndexOf("? "));
    t = (fin > MAX_PAROLE * 0.5 ? coupe.slice(0, fin + 1) : coupe) + " La suite est dans le message écrit.";
  }
  return t;
}

/** Fabrique la note vocale. Lève une erreur lisible si le service `voix` manque ou refuse. */
export async function synthese(texte: string, r?: VoixReglages): Promise<Buffer> {
  const reg = r ?? (await voixReglages());
  const p = await getProvider("voix");
  if (!p || !p.enabled) throw new Error("aucun service « voix » actif — ajoute-le au panneau (Autres services)");
  if (!p.api_key) throw new Error("le service « voix » n'a pas de clé");
  const key = decryptSecret(p.api_key);
  const base = (p.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = p.model || "gpt-4o-mini-tts";
  const corps: Record<string, unknown> = { model, voice: reg.nom, input: pourLaVoix(texte), response_format: "opus" };
  // `instructions` (ton, accent, débit) n'existe que sur les modèles récents ;
  // l'envoyer à un ancien modèle risque un refus pour paramètre inconnu.
  if (reg.consignes && /gpt-4o/.test(model)) corps.instructions = reg.consignes;

  // La voix locale (Kokoro sur le serveur) calcule à peu près en temps réel :
  // une réponse d'une minute prend une minute. 45 s la coupaient en plein
  // milieu ; un service en ligne, lui, répond en quelques secondes.
  const locale = /^http:\/\/(voix|localhost|127\.0\.0\.1)(:\d+)?\//.test(base + "/");
  const ctl = new AbortController();
  const minuterie = setTimeout(() => ctl.abort(), locale ? 150_000 : 45_000);
  try {
    const res = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(corps),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`synthèse refusée (HTTP ${res.status}) : ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(minuterie);
  }
}

/**
 * Livre une réponse selon les réglages : texte, vocal, ou les deux.
 *
 * Ne perd JAMAIS la réponse : si la voix échoue (service absent, quota,
 * Meta qui refuse), le texte part quand même. Une réponse muette parce que
 * la synthèse a planté serait pire que pas de voix du tout.
 */
export async function livrerReponse(to: string, texte: string, opts: { entrantVocal?: boolean } = {}): Promise<void> {
  const r = await voixReglages();
  const parler = r.mode === "toujours" || (r.mode === "si_vocal" && Boolean(opts.entrantVocal));
  const lien = /https?:\/\//.test(texte);
  if (!parler) {
    await sendWhatsApp(to, texte);
    return;
  }
  let vocalOk = false;
  try {
    const son = await synthese(texte, r);
    const envoi = await sendWhatsAppAudio(to, son);
    vocalOk = envoi.ok;
    if (!envoi.ok) logger.warn({ err: envoi.error }, "note vocale non livrée — le texte part seul");
  } catch (e) {
    logger.warn({ err: String(e).slice(0, 300) }, "synthèse vocale en échec — le texte part seul");
  }
  if (!vocalOk || r.texteAussi || lien) await sendWhatsApp(to, texte);
}
