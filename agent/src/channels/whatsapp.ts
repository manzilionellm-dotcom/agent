import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sandboxExec } from "../tools/sandbox.js";

/**
 * WhatsApp Business : deux fournisseurs interchangeables.
 *   meta   — Cloud API directe (graph.facebook.com). Gratuit pour répondre dans les
 *            24 h suivant un message de l'utilisateur ; au-delà, il faut un « modèle »
 *            approuvé (utility template, quelques centimes) — c'est le cas du rapport
 *            du matin si tu n'as rien écrit la veille.
 *   twilio — même chose via Twilio (frais Twilio en plus, ~0,005 $/message + Meta).
 *
 * Sécurité : signature HMAC vérifiée sur chaque webhook, liste blanche de numéros,
 * déduplication des identifiants de message.
 */

export type Inbound = {
  provider: "meta" | "twilio";
  from: string;
  text: string;
  id: string;
  name?: string;
  /** Pièce jointe à convertir en texte avant le chat (voir channels/media.ts). */
  media?: { id: string; mime: string; filename?: string; caption?: string; kind: string };
};

const META_API = "https://graph.facebook.com/v21.0";

export function whatsappEnabled(): boolean {
  return config().WHATSAPP_PROVIDER !== "none";
}

export function allowedNumbers(): Set<string> {
  return new Set(config().WHATSAPP_ALLOWED_NUMBERS.split(",").map((n) => n.replace(/[^\d]/g, "")).filter(Boolean));
}

/** Numéro principal (le premier de la liste blanche) : destinataire des rapports et alertes. */
export function primaryNumber(): string | undefined {
  return [...allowedNumbers()][0];
}

/* ------------------------------------------------------------------------ */
/* Réception                                                                 */
/* ------------------------------------------------------------------------ */

export function verifyMetaSignature(rawBody: Buffer, header: string | undefined): boolean {
  const secret = config().WHATSAPP_APP_SECRET;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = header.slice(7);
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function verifyTwilioSignature(url: string, params: Record<string, string>, header: string | undefined): boolean {
  const token = config().TWILIO_AUTH_TOKEN;
  if (!token || !header) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", token).update(data).digest("base64");
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export function parseMetaWebhook(body: unknown): Inbound[] {
  const out: Inbound[] = [];
  const entries = (body as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<Record<string, unknown>>; contacts?: Array<{ wa_id?: string; profile?: { name?: string } }> } }> }> }).entry ?? [];
  for (const e of entries) {
    for (const ch of e.changes ?? []) {
      const v = ch.value;
      const names = new Map((v?.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name]));
      for (const m of v?.messages ?? []) {
        const from = String(m.from ?? "").replace(/[^\d]/g, "");
        const id = String(m.id ?? "");
        let text = "";
        let media: Inbound["media"];
        if (m.type === "text") text = String((m.text as { body?: string })?.body ?? "");
        else if (m.type === "button") text = String((m.button as { text?: string })?.text ?? "");
        else if (m.type === "interactive") {
          const i = m.interactive as { button_reply?: { title?: string }; list_reply?: { title?: string } };
          text = i.button_reply?.title ?? i.list_reply?.title ?? "";
        } else if (m.type === "image" || m.type === "document" || m.type === "sticker" || m.type === "video") {
          // La pièce jointe n'est pas téléchargée ici : parser un webhook doit
          // rester synchrone et sans appel réseau, sinon Meta réessaie l'envoi.
          const a = m[m.type] as { id?: string; mime_type?: string; filename?: string; caption?: string } | undefined;
          const kind = m.type === "image" ? "image" : m.type === "document" ? "document" : m.type === "video" ? "vidéo" : "sticker";
          if (a?.id) media = { id: a.id, mime: a.mime_type ?? "", filename: a.filename, caption: a.caption, kind };
          text = a?.caption ?? "";
        } else if (m.type === "audio" || m.type === "voice") {
          const a = m[m.type] as { id?: string; mime_type?: string } | undefined;
          if (a?.id) media = { id: a.id, mime: a.mime_type ?? "audio/ogg", kind: "vocal" };
          else text = "[message vocal illisible]";
        }
        else text = `[${String(m.type)} non pris en charge]`;
        if (from && id && (text || media)) out.push({ provider: "meta", from, text, id, name: names.get(from), media });
      }
    }
  }
  return out;
}

export function parseTwilioWebhook(params: Record<string, string>): Inbound[] {
  const from = (params.From ?? "").replace(/^whatsapp:/, "").replace(/[^\d]/g, "");
  const id = params.MessageSid ?? "";
  const text = params.Body ?? (Number(params.NumMedia ?? "0") > 0 ? "[média non pris en charge]" : "");
  return from && id ? [{ provider: "twilio", from, text, id, name: params.ProfileName }] : [];
}

export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------------ */
/* Envoi                                                                     */
/* ------------------------------------------------------------------------ */

const LIMIT = { meta: 4000, twilio: 1500 };

function chunk(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Envoie un texte libre. Retourne false si non livré (hors fenêtre 24 h chez Meta, etc.). */
export async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  const cfg = config();
  if (cfg.WHATSAPP_PROVIDER === "none") return false;
  const max = LIMIT[cfg.WHATSAPP_PROVIDER];
  for (const part of chunk(text, max)) {
    const ok = cfg.WHATSAPP_PROVIDER === "meta" ? await sendMeta(to, { type: "text", text: { body: part, preview_url: false } }) : await sendTwilio(to, part);
    if (!ok) return false;
  }
  return true;
}

/**
 * Envoie une image prise par le navigateur (capture d'écran, graphique, page).
 *
 * L'image vit dans le sandbox, pas ici : l'orchestrateur ne peut pas la lire
 * directement, et la faire transiter en base64 par la sortie d'une commande
 * la tronquerait — une capture pèse dix fois le plafond de sortie. On
 * televerse donc DEPUIS le sandbox, et l'orchestrateur n'envoie que
 * l'identifiant rendu par Meta.
 *
 * Le jeton passe par `curl --config -`, c'est-à-dire par l'entrée standard :
 * en argument, il serait lisible dans `ps` depuis le sandbox, où tourne aussi
 * du code écrit par un modèle.
 */
export async function sendWhatsAppImage(to: string, sandboxPath: string, caption = ""): Promise<{ ok: boolean; error?: string }> {
  const cfg = config();
  if (cfg.WHATSAPP_PROVIDER !== "meta") return { ok: false, error: "envoi d'image disponible uniquement avec le fournisseur meta" };
  if (!/^\/work\/[\w./-]+\.(png|jpe?g)$/i.test(sandboxPath)) return { ok: false, error: `chemin d'image refusé : ${sandboxPath} (attendu /work/....png)` };

  const type = /\.png$/i.test(sandboxPath) ? "image/png" : "image/jpeg";
  const conf = [
    `header = "Authorization: Bearer ${cfg.WHATSAPP_ACCESS_TOKEN}"`,
    `form = "messaging_product=whatsapp"`,
    `form = "file=@${sandboxPath};type=${type}"`,
    `url = "${META_API}/${cfg.WHATSAPP_PHONE_NUMBER_ID}/media"`,
  ].join("\n");

  const r = await sandboxExec(`curl -sS --max-time 60 --config -`, { timeoutMs: 90_000, stdin: conf });
  let id: string | undefined;
  try {
    id = (JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as { id?: string }).id;
  } catch {
    /* réponse illisible : traitée comme une absence d'identifiant */
  }
  if (!id) {
    logger.error({ out: r.stdout.slice(-300), err: r.stderr.slice(-300) }, "téléversement d'image whatsapp échoué");
    return { ok: false, error: `téléversement refusé par Meta (${r.stdout.slice(-200) || r.stderr.slice(-200) || "aucune réponse"})` };
  }
  const sent = await sendMeta(to, { type: "image", image: { id, caption: caption.slice(0, 1024) } });
  return sent ? { ok: true } : { ok: false, error: lastMetaError?.message ?? "envoi refusé par Meta" };
}

/** Message hors fenêtre 24 h (Meta) : passe par le modèle approuvé `WHATSAPP_TEMPLATE_NAME` avec un paramètre texte. */
export async function sendWhatsAppTemplate(to: string, bodyParam: string): Promise<boolean> {
  const cfg = config();
  if (cfg.WHATSAPP_PROVIDER !== "meta") return sendWhatsApp(to, bodyParam); // Twilio : pas de fenêtre côté API (Meta l'applique via Twilio, avec template Twilio)
  // Les paramètres de modèle n'acceptent ni retours à la ligne ni tabulations.
  const flat = bodyParam.replace(/\s*\n+\s*/g, " · ").replace(/\t/g, " ").slice(0, 1000);
  return sendMeta(to, {
    type: "template",
    template: { name: cfg.WHATSAPP_TEMPLATE_NAME, language: { code: cfg.WHATSAPP_TEMPLATE_LANG }, components: [{ type: "body", parameters: [{ type: "text", text: flat }] }] },
  });
}

/** Rapport/alerte : texte libre d'abord, modèle si Meta refuse (hors fenêtre). */
export async function deliverWhatsApp(to: string, text: string): Promise<boolean> {
  if (await sendWhatsApp(to, text)) return true;
  if (lastMetaError?.code === 131047 || lastMetaError?.code === 131026) {
    logger.info("hors fenêtre 24 h : envoi via modèle");
    return sendWhatsAppTemplate(to, text);
  }
  return false;
}

export async function markRead(messageId: string): Promise<void> {
  const cfg = config();
  if (cfg.WHATSAPP_PROVIDER !== "meta") return;
  await fetch(`${META_API}/${cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  }).catch(() => undefined);
}

let lastMetaError: { code?: number; message?: string } | undefined;

async function sendMeta(to: string, payload: Record<string, unknown>): Promise<boolean> {
  const cfg = config();
  const res = await fetch(`${META_API}/${cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }),
  });
  if (res.ok) {
    lastMetaError = undefined;
    return true;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
  lastMetaError = body.error;
  logger.error({ status: res.status, error: body.error }, "whatsapp meta échec");
  return false;
}

async function sendTwilio(to: string, body: string): Promise<boolean> {
  const cfg = config();
  const auth = Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString("base64");
  const form = new URLSearchParams({ From: cfg.TWILIO_WHATSAPP_FROM!, To: `whatsapp:+${to}`, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) logger.error({ status: res.status, body: (await res.text()).slice(0, 300) }, "whatsapp twilio échec");
  return res.ok;
}
