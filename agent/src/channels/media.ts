import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { client, priceOf } from "../llm.js";
import { coutAppel, estDeepSeek } from "../llm/openaiCompat.js";
import { logger } from "../logger.js";
import { db } from "../memory/db.js";
import { decryptSecret } from "../vault.js";
import { transcrire, type Ecoute } from "../ecoute.js";

/**
 * Pièces jointes WhatsApp : photo, capture d'écran, PDF, document.
 *
 * Plutôt que de rendre tout le moteur multimodal, on convertit la pièce jointe
 * en texte AVANT le chat, par un appel séparé à un modèle qui voit. Le chat
 * reçoit ensuite une description, donc ça marche quel que soit le modèle de
 * conversation — et ça continuera de marcher si celui-ci change.
 *
 * Qui regarde : pour une IMAGE, deepseek-flash d'abord (il voit depuis la
 * V4.1, au plus 1024 jetons par image, soit un tiers de millième de dollar),
 * Claude si DeepSeek manque ou échoue. Pour un PDF, Claude seul : DeepSeek ne
 * lit pas les documents. Avant, tout passait par Claude, et sans clé
 * Anthropic le bot ne voyait rien du tout.
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

/** Le modèle DeepSeek qui voit : seul deepseek-flash a la vision (deepseek-v4-pro non). */
export const MODELE_VISION_DEEPSEEK = "deepseek-flash";

export type Oeil = { base: string; cle: string; nom: string };

/**
 * Une clé DeepSeek, d'où qu'elle vienne : une carte du panneau dont l'adresse
 * est deepseek.com, sinon le .env. Le modèle de la carte ne compte pas : la
 * vision impose deepseek-flash.
 */
export async function oeilDeepSeek(): Promise<Oeil | undefined> {
  try {
    const r = await db().query<{ id: string; base_url: string; api_key: string }>(
      `SELECT id, base_url, api_key FROM providers WHERE enabled AND api_key IS NOT NULL AND base_url ILIKE '%deepseek.com%' ORDER BY priority LIMIT 1`,
    );
    const x = r.rows[0];
    if (x) return { base: x.base_url.replace(/\/+$/, ""), cle: decryptSecret(x.api_key), nom: x.id };
  } catch (e) {
    logger.warn({ err: String(e) }, "recherche d'une clé DeepSeek impossible");
  }
  const c = config();
  if (c.OPENAI_COMPAT_API_KEY && estDeepSeek(c.OPENAI_COMPAT_BASE_URL)) {
    return { base: c.OPENAI_COMPAT_BASE_URL!.replace(/\/+$/, ""), cle: c.OPENAI_COMPAT_API_KEY, nom: ".env" };
  }
  return undefined;
}

/**
 * Décrit une image avec deepseek-flash. Format vérifié dans le guide Vision
 * de DeepSeek : un bloc `image_url` portant une URL `data:` en base64.
 * Réflexion « low » : décrire une photo ne demande pas de raisonner longtemps,
 * et le mode réflexion est activé par défaut chez DeepSeek.
 */
export async function decrireImageDeepSeek(oeil: Oeil, bytes: Buffer, mime: string, caption?: string): Promise<{ texte: string; usd: number }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90_000);
  try {
    const res = await fetch(`${oeil.base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${oeil.cle}`, "content-type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        model: MODELE_VISION_DEEPSEEK,
        reasoning_effort: "low",
        max_tokens: 2_000,
        messages: [
          { role: "system", content: PROMPT },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } },
              { type: "text", text: caption ? `Légende envoyée avec : ${caption}` : "Décris cette pièce jointe." },
            ],
          },
        ],
      }),
    });
    const corps = await res.text();
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status} ${corps.slice(0, 200)}`);
    const j = JSON.parse(corps) as { choices?: Array<{ message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } };
    const texte = (j.choices?.[0]?.message?.content ?? "").trim();
    if (!texte) throw new Error("DeepSeek a rendu une description vide");
    return { texte, usd: coutAppel(MODELE_VISION_DEEPSEEK, j.usage as never).usd };
  } finally {
    clearTimeout(t);
  }
}

async function compterDepense(usd: number): Promise<void> {
  await db()
    .query(`INSERT INTO spend(day, usd) VALUES (CURRENT_DATE, $1) ON CONFLICT (day) DO UPDATE SET usd = spend.usd + EXCLUDED.usd`, [usd])
    .catch(() => undefined);
}

/**
 * Convertit une pièce jointe en texte. Renvoie `undefined` si le type n'est pas
 * pris en charge ou si l'appel échoue — l'appelant garde alors le texte brut du
 * message, plutôt que de perdre le message entier à cause de sa pièce jointe.
 */
export async function describeMedia(ref: MediaRef, deja?: Fetched): Promise<string | undefined> {
  const cfg = config();
  const got = deja ?? (await fetchMetaMedia(ref.id));
  if (!got) return undefined;

  const mime = got.mime.split(";")[0]!.trim();

  // Une image : DeepSeek d'abord, Claude en secours.
  if (IMAGE_MIME.has(mime)) {
    const oeil = await oeilDeepSeek();
    if (oeil) {
      try {
        const d = await decrireImageDeepSeek(oeil, got.bytes, mime, ref.caption);
        await compterDepense(d.usd);
        logger.info({ kind: ref.kind, mime, usd: d.usd.toFixed(4), oeil: oeil.nom }, "pièce jointe lue par DeepSeek");
        return d.texte;
      } catch (e) {
        logger.warn({ err: String(e).slice(0, 200) }, "DeepSeek n'a pas pu lire l'image — on tente Claude");
      }
    }
  }

  if (!cfg.ANTHROPIC_API_KEY) {
    logger.warn({ mime }, "pièce jointe reçue mais aucun modèle pour la lire (ni DeepSeek pour une image, ni clé Anthropic)");
    return undefined;
  }
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
    await compterDepense(usd);
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

/** Où les pièces jointes reçues sont rangées dans le sandbox, à côté de /work/downloads. */
export const DOSSIER_RECUS = "/work/whatsapp";
const JOURS_CONSERVATION = 30;

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv", "application/json": "json",
};

/**
 * Dépose la pièce jointe dans /work, là où le navigateur du bot peut la
 * reprendre avec browser{action:"upload"}. Sans ça, une photo envoyée sur
 * WhatsApp n'existait que comme description : le bot pouvait dire ce qu'elle
 * montrait, mais pas la mettre dans une annonce Vinted, et répondait
 * « envoie-les moi en fichier » à quelqu'un qui venait de le faire.
 *
 * Écriture par l'entrée standard (pas en argument de commande) : 12 Mo de
 * base64 dépassent la ligne de commande, et le sandbox exécute aussi du code
 * écrit par un modèle. Les fichiers de plus de 30 jours sont effacés au
 * passage. Un échec ne fait rien perdre : la description reste.
 */
export async function deposerPieceJointe(ref: MediaRef, got: Fetched): Promise<string | undefined> {
  const mime = got.mime.split(";")[0]!.trim();
  const ext = EXT[mime] ?? (ref.filename?.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase() ?? "bin");
  const base = (ref.filename ?? "").replace(/\.[^.]*$/, "").replace(/[^\w-]+/g, "_").slice(0, 40);
  const jour = new Date().toISOString().slice(0, 10);
  const chemin = `${DOSSIER_RECUS}/${jour}-${ref.id.replace(/[^\w]/g, "").slice(-12)}${base ? `-${base}` : ""}.${ext}`;
  try {
    const { sandboxExec, shellQuote } = await import("../tools/sandbox.js");
    const r = await sandboxExec(
      `mkdir -p ${shellQuote(DOSSIER_RECUS)} && find ${shellQuote(DOSSIER_RECUS)} -type f -mtime +${JOURS_CONSERVATION} -delete 2>/dev/null; base64 -d > ${shellQuote(chemin)} && wc -c < ${shellQuote(chemin)}`,
      { timeoutMs: 60_000, stdin: got.bytes.toString("base64") },
    );
    const octets = Number(r.stdout.trim());
    if (r.code !== 0 || octets !== got.bytes.byteLength) {
      logger.warn({ code: r.code, octets, attendu: got.bytes.byteLength, err: r.stderr.slice(0, 200) }, "dépôt de la pièce jointe dans /work en échec");
      return undefined;
    }
    logger.info({ chemin, octets }, "pièce jointe déposée dans /work");
    return chemin;
  } catch (e) {
    logger.warn({ err: String(e).slice(0, 200) }, "dépôt de la pièce jointe impossible");
    return undefined;
  }
}

export type PieceJointe = { id: number; chemin: string; mime: string; nom: string; legende: string; description: string; octets: number; ts: string };

/** Les pièces jointes des derniers jours, la plus récente d'abord. */
export async function listerPiecesJointes(jours = 30, limite = 30): Promise<PieceJointe[]> {
  const r = await db().query<PieceJointe>(
    `SELECT id, chemin, mime, nom, legende, description, octets, ts FROM pieces_jointes
     WHERE ts > now() - ($1 || ' days')::interval ORDER BY ts DESC LIMIT $2`,
    [String(Math.max(1, Math.min(365, jours))), Math.max(1, Math.min(200, limite))],
  );
  return r.rows;
}

async function noterPieceJointe(p: { peer: string; chemin: string; mime: string; nom: string; legende: string; description: string; octets: number }): Promise<void> {
  await db()
    .query(
      `INSERT INTO pieces_jointes(peer, chemin, mime, nom, legende, description, octets) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.peer, p.chemin, p.mime, p.nom.slice(0, 200), p.legende.slice(0, 1000), p.description.slice(0, 2000), p.octets],
    )
    .catch((e) => logger.warn({ err: String(e) }, "pièce jointe non notée en base"));
}

/** Texte à donner au chat : la description de la pièce jointe, plus la légende s'il y en a une. */
export async function mediaToText(ref: MediaRef, peer = ""): Promise<string> {
  if (ref.kind === "vocal") {
    const e = await transcribeAudio(ref);
    if (e.ok) return `[message vocal de Lionel, transcrit — réponds-y comme à un message écrit]\n${e.texte}`;
    // Le chat doit DIRE qu'il n'a pas entendu, et pourquoi : un « d'accord »
    // en réponse à un vocal qu'il n'a pas compris, c'est pire qu'un silence.
    return e.configure
      ? `[message vocal reçu mais je n'ai pas pu l'écouter : ${e.raison}. Dis-le à Lionel en une ligne et demande-lui de le renvoyer ou de l'écrire.]`
      : `[message vocal reçu mais l'écoute n'est pas branchée (${e.raison}). Dis-le à Lionel en une ligne et envoie-lui lien_panneau section voix.]`;
  }
  const got = await fetchMetaMedia(ref.id);
  const label = ref.filename ? `${ref.kind} « ${ref.filename} »` : ref.kind;
  if (!got) return `[${label} reçu — je n'ai pas pu le télécharger]${ref.caption ? `\n${ref.caption}` : ""}`;
  // Le dépôt et la lecture partent ensemble : la lecture prend quelques
  // secondes de modèle, le dépôt une fraction, et aucun n'attend l'autre.
  const [chemin, described] = await Promise.all([deposerPieceJointe(ref, got), describeMedia(ref, got)]);
  if (chemin) {
    await noterPieceJointe({ peer, chemin, mime: got.mime.split(";")[0]!.trim(), nom: ref.filename ?? "", legende: ref.caption ?? "", description: described ?? "", octets: got.bytes.byteLength });
  }
  const fichier = chemin ? `[fichier enregistré sur le serveur : ${chemin} — pour le mettre dans un formulaire (annonce Vinted, Blocket, pièce jointe), browser{action:"upload", file:"${chemin}"}. Ne demande jamais à Lionel de le renvoyer « en fichier ».]` : "";
  if (!described) return [`[${label} reçu — je n'ai pas pu le lire]`, fichier, ref.caption ?? ""].filter(Boolean).join("\n");
  return [`[${label} reçu, voici ce qu'il contient]`, described, fichier, ref.caption ? `\nLégende : ${ref.caption}` : ""].filter(Boolean).join("\n");
}
