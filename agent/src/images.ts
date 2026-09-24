import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { logger } from "./logger.js";
import { getProvider } from "./providers.js";
import { decryptSecret } from "./vault.js";
import { sendWhatsAppMedia } from "./channels/whatsapp.js";

/**
 * Génération d'images — l'équivalent de Grok Imagine.
 *
 * Un service `image` au panneau, compatible avec `POST /images/generations`.
 * Deux fournisseurs vérifiés dans leur documentation :
 *   - OpenAI (https://api.openai.com/v1, gpt-image-1) : rend TOUJOURS
 *     l'image en base64, et refuse le paramètre `response_format` ;
 *   - xAI, c'est-à-dire le moteur de Grok lui-même
 *     (https://api.x.ai/v1, grok-imagine-image-2.0) : même adresse, même
 *     format de requête, et peut rendre un lien vers l'image.
 * On n'envoie donc pas `response_format`, et on accepte les deux réponses.
 */

const TAILLE_MAX = 10 * 1024 * 1024;

export async function genererImage(description: string): Promise<Buffer> {
  const p = await getProvider("image");
  if (!p || !p.enabled) throw new Error("aucun service « image » actif — ajoute-le au panneau (identifiant image)");
  if (!p.api_key) throw new Error("le service « image » n'a pas de clé");
  const base = (p.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = p.model || "gpt-image-1";
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 120_000);
  try {
    const res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${decryptSecret(p.api_key)}`, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: description.slice(0, 4_000), n: 1 }),
      signal: ctl.signal,
    });
    const texte = await res.text();
    if (!res.ok) throw new Error(`génération refusée (HTTP ${res.status}) : ${texte.slice(0, 250)}`);
    const j = JSON.parse(texte) as { data?: Array<{ b64_json?: string; url?: string }> };
    const d = j.data?.[0];
    if (d?.b64_json) return Buffer.from(d.b64_json, "base64");
    if (d?.url) {
      const img = await fetch(d.url, { signal: ctl.signal });
      if (!img.ok) throw new Error(`image générée mais illisible (HTTP ${img.status})`);
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length > TAILLE_MAX) throw new Error("image trop lourde pour WhatsApp");
      return buf;
    }
    throw new Error("le service n'a rendu ni image ni lien");
  } finally {
    clearTimeout(t);
  }
}

/** PNG, JPEG ou WebP, d'après les premiers octets : WhatsApp refuse un type annoncé qui ne correspond pas au contenu. */
export function typeImage(b: Buffer): { mime: string; ext: string } {
  if (b[0] === 0x89 && b[1] === 0x50) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: "image/jpeg", ext: "jpg" };
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return { mime: "image/webp", ext: "webp" };
  return { mime: "image/png", ext: "png" };
}

/**
 * Retouche d'une image existante — « enlève le fond », « mets la casquette
 * sur fond blanc », « recadre sur le produit », « rends-la plus lumineuse ».
 * Deux API vérifiées dans leur documentation (24/09/2026) :
 *   - OpenAI : POST /images/edits en multipart (champs image, prompt, model),
 *     réponse en b64_json ;
 *   - xAI : POST /images/edits en JSON, `image: { url: <data URI>, type }`,
 *     réponse avec un lien (data[0].url).
 * Le service est le même que pour la création (« image » au panneau), donc
 * rien de plus à configurer. L'image source est un fichier de /work, en
 * général une photo reçue sur WhatsApp ; elle est lue depuis le sandbox.
 */
const LECTURE_MAX = 24 * 1024 * 1024;

export async function lireFichierSandbox(chemin: string): Promise<Buffer> {
  if (!chemin.startsWith("/work/") || chemin.includes("/../")) throw new Error(`chemin refusé : ${chemin} (attendu sous /work)`);
  const { sandboxExec, shellQuote } = await import("./tools/sandbox.js");
  const r = await sandboxExec(`base64 -w0 ${shellQuote(chemin)}`, { timeoutMs: 60_000, maxOutput: LECTURE_MAX });
  if (r.code !== 0) throw new Error(`fichier illisible : ${chemin} (${r.stderr.trim().slice(0, 120) || "introuvable"})`);
  const buf = Buffer.from(r.stdout.trim(), "base64");
  if (!buf.length) throw new Error(`fichier vide : ${chemin}`);
  return buf;
}

export async function retoucherImage(source: Buffer, consigne: string): Promise<Buffer> {
  const p = await getProvider("image");
  if (!p || !p.enabled) throw new Error("aucun service « image » actif — ajoute-le au panneau (identifiant image)");
  if (!p.api_key) throw new Error("le service « image » n'a pas de clé");
  const base = (p.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = p.model || "gpt-image-1";
  const cle = decryptSecret(p.api_key);
  const t = typeImage(source);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180_000);
  try {
    let res: Response;
    if (/x\.ai/i.test(base)) {
      res = await fetch(`${base}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${cle}`, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: consigne.slice(0, 4_000), image: { url: `data:${t.mime};base64,${source.toString("base64")}`, type: "image_url" } }),
        signal: ctl.signal,
      });
    } else {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", consigne.slice(0, 4_000));
      form.append("image", new Blob([new Uint8Array(source)], { type: t.mime }), `source.${t.ext}`);
      res = await fetch(`${base}/images/edits`, { method: "POST", headers: { authorization: `Bearer ${cle}` }, body: form, signal: ctl.signal });
    }
    const texte = await res.text();
    if (!res.ok) throw new Error(`retouche refusée (HTTP ${res.status}) : ${texte.slice(0, 250)}`);
    const j = JSON.parse(texte) as { data?: Array<{ b64_json?: string; url?: string }>; url?: string };
    const d = j.data?.[0] ?? (j.url ? { url: j.url } : undefined);
    if (d?.b64_json) return Buffer.from(d.b64_json, "base64");
    if (d?.url) {
      const img = await fetch(d.url, { signal: ctl.signal });
      if (!img.ok) throw new Error(`image retouchée mais illisible (HTTP ${img.status})`);
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length > TAILLE_MAX) throw new Error("image trop lourde pour WhatsApp");
      return buf;
    }
    throw new Error("le service n'a rendu ni image ni lien");
  } finally {
    clearTimeout(timer);
  }
}

/** Range une image produite ici dans /work/whatsapp, à côté des photos reçues : l'annonce peut la reprendre. */
export async function deposerImageProduite(img: Buffer, nom: string): Promise<string | undefined> {
  const t = typeImage(img);
  const chemin = `/work/whatsapp/${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}-${nom.replace(/[^\w-]+/g, "_").slice(0, 30)}.${t.ext}`;
  try {
    const { sandboxExec, shellQuote } = await import("./tools/sandbox.js");
    const r = await sandboxExec(`mkdir -p /work/whatsapp && base64 -d > ${shellQuote(chemin)} && wc -c < ${shellQuote(chemin)}`, { timeoutMs: 60_000, stdin: img.toString("base64") });
    if (r.code !== 0 || Number(r.stdout.trim()) !== img.byteLength) return undefined;
    const { db } = await import("./memory/db.js");
    await db()
      .query(`INSERT INTO pieces_jointes(peer, chemin, mime, nom, legende, description, octets) VALUES ('', $1, $2, $3, '', $4, $5)`, [chemin, t.mime, nom.slice(0, 200), "image retouchée par le bot", img.byteLength])
      .catch(() => undefined);
    return chemin;
  } catch (e) {
    logger.warn({ err: String(e).slice(0, 200) }, "image retouchée non déposée dans /work");
    return undefined;
  }
}

export function outilRetouche(canal: string, peer: string) {
  return betaZodTool({
    name: "retoucher_photo",
    description:
      "Retouche une photo déjà reçue (chemin /work/whatsapp/… donné dans le message ou par fichiers_recus) : enlever ou changer le fond, fond blanc pour une annonce, recadrer sur le produit, éclaircir, effacer un détail, mettre en scène. Écris toi-même une consigne précise en anglais ou en français. Le résultat part sur WhatsApp ET reste sur le serveur (nouveau chemin rendu) pour l'annonce.",
    inputSchema: z.object({
      fichier: z.string().min(6).describe("Chemin absolu sous /work de la photo à retoucher"),
      consigne: z.string().min(3).max(4_000).describe("Ce qu'il faut changer, précisément"),
      legende: z.string().max(900).optional(),
    }),
    run: async (i) => {
      if (canal !== "whatsapp") return "Envoi d'image indisponible sur ce canal.";
      const source = await lireFichierSandbox(i.fichier);
      const img = await retoucherImage(source, i.consigne);
      const t = typeImage(img);
      const [chemin, envoi] = await Promise.all([
        deposerImageProduite(img, `retouche-${i.fichier.split("/").pop()?.replace(/\.[^.]*$/, "") ?? "photo"}`),
        sendWhatsAppMedia(peer, img, { mime: t.mime, type: "image", fichier: `retouche.${t.ext}`, legende: i.legende }),
      ]);
      if (!envoi.ok) return `Error: image retouchée${chemin ? ` (enregistrée : ${chemin})` : ""} mais non envoyée — ${envoi.error}`;
      logger.info({ octets: img.length, chemin }, "photo retouchée et envoyée");
      return chemin ? `photo retouchée envoyée et enregistrée : ${chemin} (utilisable avec browser upload).` : "photo retouchée envoyée.";
    },
  });
}

export function outilImage(canal: string, peer: string) {
  return betaZodTool({
    name: "generer_image",
    description:
      "Crée une image à partir d'une description et l'envoie à Lionel sur WhatsApp — visuel, logo, bannière, illustration pour un site, mise en scène d'un produit. Écris toi-même une description détaillée (sujet, style, cadrage, couleurs, texte éventuel) à partir de ce qu'il a dit.",
    inputSchema: z.object({
      description: z.string().min(3).max(4_000),
      legende: z.string().max(900).optional().describe("Une ligne sous l'image"),
    }),
    run: async (i) => {
      if (canal !== "whatsapp") return "Envoi d'image indisponible sur ce canal.";
      const img = await genererImage(i.description);
      const t = typeImage(img);
      const envoi = await sendWhatsAppMedia(peer, img, { mime: t.mime, type: "image", fichier: `image.${t.ext}`, legende: i.legende });
      if (!envoi.ok) return `Error: image créée mais non envoyée — ${envoi.error}`;
      logger.info({ octets: img.length }, "image générée et envoyée");
      return "image envoyée.";
    },
  });
}
