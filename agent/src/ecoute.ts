import { config } from "./config.js";
import { db } from "./memory/db.js";
import { logger } from "./logger.js";
import { getProvider, setting } from "./providers.js";
import { decryptSecret } from "./vault.js";
import { enregistrer } from "./boite-noire.js";

/**
 * L'écoute des messages vocaux.
 *
 * Jusqu'ici la transcription ne s'activait que par TRANSCRIBE_API_KEY dans le
 * .env du serveur : une ligne à ajouter en ssh, que personne n'a ajoutée. Le
 * bot recevait donc chaque vocal et répondait « transcription non
 * configurée » — il « n'entendait pas ».
 *
 * Désormais la clé se trouve dans cet ordre, sans rien toucher au serveur :
 *  1. le service « ecoute » du panneau (section Voix) ;
 *  2. l'ancien réglage du .env, s'il existe ;
 *  3. une clé Groq ou OpenAI déjà présente au panneau pour autre chose
 *     (modèle, voix, image) : la même clé sait transcrire.
 * Groq passe avant OpenAI : Whisper large-v3 turbo y est plus rapide et bien
 * moins cher, avec la même qualité en français.
 */

export type SourceEcoute = { nom: string; base: string; cle: string; modele: string };

const GROQ = "https://api.groq.com/openai/v1";
const OPENAI = "https://api.openai.com/v1";

/** Le bon modèle selon le fournisseur : chacun nomme Whisper à sa façon. */
export function modelePour(base: string, choisi?: string): string {
  if (choisi) return choisi;
  if (/groq\.com/i.test(base)) return "whisper-large-v3-turbo";
  if (/openai\.com/i.test(base)) return "gpt-4o-mini-transcribe";
  // Mistral : Voxtral Mini Transcribe, 0,003 $ la minute, même endpoint
  // /audio/transcriptions (docs.mistral.ai, lu le 25/09/2026).
  if (/mistral\.ai/i.test(base)) return "voxtral-mini-latest";
  return "whisper-1";
}

/** Mistral n'accepte pas le champ `prompt` de Whisper : on ne lui envoie que le fichier et le modèle. */
export function estMistral(base: string): boolean {
  return /mistral\.ai/i.test(base);
}

export const LANGUES_ECOUTE: Record<string, string> = {
  fr: "Français (le plus précis si tu parles français)",
  auto: "Détection automatique (si tu mélanges les langues)",
  en: "Anglais",
  sv: "Suédois",
  rw: "Kinyarwanda",
};

export async function langueEcoute(): Promise<string> {
  const v = await setting("ECOUTE_LANGUE").catch(() => undefined);
  return v && v in LANGUES_ECOUTE ? v : "fr";
}

export async function sourceEcoute(): Promise<SourceEcoute | undefined> {
  // 1. Le service dédié du panneau.
  const p = await getProvider("ecoute").catch(() => undefined);
  if (p?.enabled && p.api_key) {
    try {
      const base = (p.base_url || GROQ).replace(/\/+$/, "");
      return { nom: p.label || "écoute", base, cle: decryptSecret(p.api_key), modele: modelePour(base, p.model || undefined) };
    } catch (e) {
      logger.error({ err: String(e) }, "clé d'écoute illisible");
    }
  }
  // 2. L'ancien réglage du .env.
  const c = config();
  if (c.TRANSCRIBE_API_KEY && c.TRANSCRIBE_BASE_URL) {
    const base = c.TRANSCRIBE_BASE_URL.replace(/\/+$/, "");
    const modele = c.TRANSCRIBE_MODEL === "whisper-large-v3" && !/groq/i.test(base) ? modelePour(base) : c.TRANSCRIBE_MODEL;
    return { nom: ".env", base, cle: c.TRANSCRIBE_API_KEY, modele };
  }
  // 3. Une clé Groq, Mistral ou OpenAI déjà là pour autre chose. Mistral
  //    est presque toujours là (c'est le modèle de conversation) : les
  //    vocaux marchent donc sans rien coller de plus.
  try {
    const r = await db().query<{ id: string; label: string; base_url: string; api_key: string }>(
      `SELECT id, label, base_url, api_key FROM providers WHERE enabled AND api_key IS NOT NULL AND (base_url ILIKE '%groq.com%' OR base_url ILIKE '%mistral.ai%' OR base_url ILIKE '%api.openai.com%' OR id IN ('voix','image'))
       ORDER BY CASE WHEN base_url ILIKE '%groq.com%' THEN 0 WHEN base_url ILIKE '%mistral.ai%' THEN 1 ELSE 2 END, priority`,
    );
    for (const x of r.rows) {
      const base = (x.base_url || OPENAI).replace(/\/+$/, "");
      if (!/groq\.com|mistral\.ai|api\.openai\.com/i.test(base)) continue;
      try {
        return { nom: `${x.label || x.id} (réutilisée)`, base, cle: decryptSecret(x.api_key), modele: modelePour(base) };
      } catch {
        /* clé illisible : on essaie la suivante */
      }
    }
  } catch (e) {
    logger.warn({ err: String(e) }, "recherche d'une clé d'écoute impossible");
  }
  return undefined;
}

export type Ecoute = { ok: true; texte: string } | { ok: false; raison: string; configure: boolean };

/** Les mots qu'un modèle généraliste écorche : les donner d'avance améliore nettement la transcription. */
const VOCABULAIRE = "Lionel, Manzi Junior, IPTV, 8K, Vinted, Blocket, WhatsApp, panneau, coffre, adresse MAC, Vercel, GitHub.";

/**
 * Transcrit un son. Une nouvelle tentative sur une erreur passagère (429,
 * 5xx, coupure réseau) : un vocal perdu pour un hoquet du fournisseur, c'est
 * un message de Lionel qui n'a jamais été lu.
 */
export async function transcrire(son: Buffer, mime: string, source?: SourceEcoute): Promise<Ecoute> {
  const s = source ?? (await sourceEcoute());
  if (!s) return { ok: false, configure: false, raison: "aucune clé d'écoute : une clé Mistral, Groq (gratuite) ou OpenAI au panneau suffit" };
  const langue = await langueEcoute();
  const debut = Date.now();
  let derniere = "";
  for (let essai = 1; essai <= 2; essai++) {
    const form = new FormData();
    const ext = /mpeg|mp3/.test(mime) ? "mp3" : /mp4|m4a|aac/.test(mime) ? "m4a" : /wav/.test(mime) ? "wav" : /webm/.test(mime) ? "webm" : "ogg";
    form.append("file", new Blob([new Uint8Array(son)], { type: mime.split(";")[0] || "audio/ogg" }), `vocal.${ext}`);
    form.append("model", s.modele);
    if (langue !== "auto") form.append("language", langue);
    if (!estMistral(s.base)) form.append("prompt", VOCABULAIRE);
    try {
      const res = await fetch(`${s.base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.cle}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const out = (await res.json().catch(() => ({}))) as { text?: string };
        const texte = (out.text ?? "").trim();
        enregistrer({ type: "outil", titre: "écoute d'un vocal", detail: { source: s.nom, modele: s.modele, caracteres: texte.length }, ok: Boolean(texte), niveau: texte ? "info" : "warn", dureeMs: Date.now() - debut });
        return texte ? { ok: true, texte } : { ok: false, configure: true, raison: "le vocal semble vide ou inaudible" };
      }
      const corps = (await res.text().catch(() => "")).slice(0, 200);
      derniere = res.status === 401 || res.status === 403 ? `clé d'écoute refusée par ${s.nom} (HTTP ${res.status})` : `${s.nom} a répondu HTTP ${res.status} ${corps}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      derniere = `${s.nom} injoignable : ${String(e).slice(0, 120)}`;
    }
    if (essai === 1) await new Promise((r) => setTimeout(r, 1500));
  }
  logger.error({ source: s.nom, raison: derniere }, "écoute d'un vocal en échec");
  enregistrer({ type: "outil", titre: "écoute d'un vocal", detail: { source: s.nom, erreur: derniere }, ok: false, dureeMs: Date.now() - debut });
  return { ok: false, configure: true, raison: derniere };
}
