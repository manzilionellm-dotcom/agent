import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { client, priceOf } from "../llm.js";
import { logger } from "../logger.js";
import { db } from "../memory/db.js";
import { transcrire, type Ecoute } from "../ecoute.js";

/**
 * Pièces jointes WhatsApp : photo, capture d'écran, PDF, document.
 *
 * Le modèle de conversation est DeepSeek, qui ne voit ni les images ni les PDF.
 * Plutôt que de rendre tout le moteur multimodal, on convertit la pièce jointe
 * en texte AVANT le chat, par un appel séparé à un modèle qui voit. Le chat
 * reçoit ensuite une description, donc ça marche quel que soit le modèle de
 * conversation — et ça continuera de marcher si celui-ci change.
 *
 * Coût : un appel Claude par pièce jointe, compté dans la dépense du jour.
 */

const META_API = "https://graph.facebook.com/v21.0";

/** 12 Mo : au-delà, Meta lui-même refuse, et l'encodage base64 pèserait 16 Mo en mémoire. */
const MAX_BYTES = 12 * 1024 * 1024;

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type MediaRef = { id: string; mime: string; filename?: string; caption?: string; kind: string };

type Fetched = { bytes: Buffer; mime: string };

/**
 * Meta ne sert pas le fichier directement : il faut d'abord demander une URL
 * signée, puis la télécharger AVEC le jeton — une requête non authentifiée sur
 * cette URL renvoie 401, ce que la documentation ne souligne pas.
 */
async function fetchMetaMedia(id: string): Promise<Fetched | undefined> {
  const token = config().WHATSAPP_ACCESS_TOKEN;
  if (!token) return undefined;
  const meta = await fetch(`${META_API}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!meta.ok) {
    logger.error({ id, status: meta.status }, "média : URL introuvable");
    return undefined;
  }
  const info = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
  if (!info.url) return undefined;
  if (info.file_size && info.file_size > MAX_BYTES) {
    logger.warn({ id, size: info.file_size }, "média trop volumineux");
    return undefined;
  }
  const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!bin.ok) {
    logger.error({ id, status: bin.status }, "média : téléchargement refusé");
    return undefined;
  }
  const bytes = Buffer.from(await bin.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return undefined;
  return { bytes, mime: info.mime_type ?? "application/octet-stream" };
}

const PROMPT = `Tu décris une pièce jointe reçue sur WhatsApp, pour quelqu'un qui ne la voit pas.

Transcris d'abord TOUT texte lisible, mot pour mot : marques, étiquettes, montants, dates, numéros, noms de champs. C'est le plus souvent ce qui compte.
Décris ensuite ce qu'on voit, en deux ou trois phrases factuelles.
Si c'est une capture d'écran, dis de quelle application ou de quel site, et ce qui est affiché.
Si c'est un document, donne sa nature, son émetteur, et les chiffres clés.

N'interprète pas, ne conseille pas, n'invente rien. Si quelque chose est illisible, écris « illisible ».`;

/**
 * Convertit une pièce jointe en texte. Renvoie `undefined` si le type n'est pas
 * pris en charge ou si l'appel échoue — l'appelant garde alors le texte brut du
 * message, plutôt que de perdre le message entier à cause de sa pièce jointe.
 */
export async function describeMedia(ref: MediaRef): Promise<string | undefined> {
  const cfg = config();
  if (!cfg.ANTHROPIC_API_KEY) {
    logger.warn("pièce jointe reçue mais ANTHROPIC_API_KEY absente : pas de lecture possible");
    return undefined;
  }
  const got = await fetchMetaMedia(ref.id);
  if (!got) return undefined;

  const mime = got.mime.split(";")[0]!.trim();
  let block: Anthropic.Beta.Messages.BetaContentBlockParam;
  if (IMAGE_MIME.has(mime)) {
    block = { type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: got.bytes.toString("base64") } };
  } else if (mime === "application/pdf") {
    block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: got.bytes.toString("base64") } };
  } else if (mime.startsWith("text/") || mime === "application/json") {
    // Un .txt ou un .csv n'a pas besoin d'un modèle : on le rend tel quel.
    return got.bytes.toString("utf8").slice(0, 20_000);
  } else {
    return undefined;
  }

  // Le modèle de vision est celui des missions critiques (Claude), jamais celui
  // du chat : en mode éco, le chat est un modèle texte qui refuserait le bloc.
  const model = cfg.MODEL_CRITICAL ?? "claude-sonnet-5";
  try {
    const res = await client().beta.messages.create({
      model,
      max_tokens: 2_000,
      system: PROMPT,
      messages: [{ role: "user", content: [block, { type: "text", text: ref.caption ? `Légende envoyée avec : ${ref.caption}` : "Décris cette pièce jointe." }] }],
    });
    const usd = priceOf(model, res.usage);
    await db()
      .query(`INSERT INTO spend(day, usd) VALUES (CURRENT_DATE, $1) ON CONFLICT (day) DO UPDATE SET usd = spend.usd + EXCLUDED.usd`, [usd])
      .catch(() => undefined);
    const text = res.content
      .filter((c): c is Anthropic.Beta.Messages.BetaTextBlock => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    logger.info({ kind: ref.kind, mime, usd: usd.toFixed(4) }, "pièce jointe lue");
    return text || undefined;
  } catch (e) {
    logger.error({ err: String(e), mime }, "lecture de la pièce jointe en échec");
    return undefined;
  }
}

/**
 * Message vocal → texte. La source (clé, modèle) se trouve dans ecoute.ts :
 * panneau d'abord, .env ensuite, puis une clé Groq/OpenAI déjà présente.
 */
export async function transcribeAudio(ref: MediaRef): Promise<Ecoute> {
  const got = await fetchMetaMedia(ref.id);
  if (!got) return { ok: false, configure: true, raison: "impossible de télécharger le vocal depuis WhatsApp" };
  return transcrire(got.bytes, got.mime);
}

/** Texte à donner au chat : la description de la pièce jointe, plus la légende s'il y en a une. */
export async function mediaToText(ref: MediaRef): Promise<string> {
  if (ref.kind === "vocal") {
    const e = await transcribeAudio(ref);
    if (e.ok) return `[message vocal de Lionel, transcrit — réponds-y comme à un message écrit]\n${e.texte}`;
    // Le chat doit DIRE qu'il n'a pas entendu, et pourquoi : un « d'accord »
    // en réponse à un vocal qu'il n'a pas compris, c'est pire qu'un silence.
    return e.configure
      ? `[message vocal reçu mais je n'ai pas pu l'écouter : ${e.raison}. Dis-le à Lionel en une ligne et demande-lui de le renvoyer ou de l'écrire.]`
      : `[message vocal reçu mais l'écoute n'est pas branchée (${e.raison}). Dis-le à Lionel en une ligne et envoie-lui lien_panneau section voix.]`;
  }
  const described = await describeMedia(ref);
  const label = ref.filename ? `${ref.kind} « ${ref.filename} »` : ref.kind;
  if (!described) return `[${label} reçu — je n'ai pas pu le lire]${ref.caption ? `\n${ref.caption}` : ""}`;
  return [`[${label} reçu, voici ce qu'il contient]`, described, ref.caption ? `\nLégende : ${ref.caption}` : ""].filter(Boolean).join("\n");
}
