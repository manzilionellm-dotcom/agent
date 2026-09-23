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
