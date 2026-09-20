import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { deliverWhatsApp, primaryNumber, whatsappEnabled } from "../channels/whatsapp.js";

/**
 * Canaux de notification. WhatsApp est le canal principal (channels/whatsapp.ts) ;
 * Telegram reste un secours gratuit et sans fenêtre de 24 h.
 */
export async function sendTelegram(markdown: string): Promise<boolean> {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = config();
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  // Telegram limite à 4096 caractères par message.
  const chunks = markdown.match(/[\s\S]{1,3900}/g) ?? [];
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: chunk, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      logger.error({ status: res.status, body: await res.text() }, "telegram échec");
      return false;
    }
  }
  return true;
}

/** Alerte immédiate (Telegram) : réservée aux changements qui méritent d'interrompre l'humain. */
export const alertTool = betaZodTool({
  name: "send_alert",
  description:
    "Envoie une alerte immédiate à l'opérateur (Telegram). À utiliser UNIQUEMENT pour un changement significatif et vérifié : baisse de prix d'un concurrent, site en erreur, déploiement cassé, opportunité datée. Pas pour le reporting courant (le rapport du matin s'en charge).",
  inputSchema: z.object({
    severity: z.enum(["info", "warning", "critical"]),
    title: z.string().max(120),
    body: z.string().max(1500),
    source_url: z.string().url().optional(),
  }),
  run: async (i) => {
    const icon = i.severity === "critical" ? "🔴" : i.severity === "warning" ? "🟠" : "🔵";
    const text = `${icon} ${i.title}\n\n${i.body}${i.source_url ? `\n\n${i.source_url}` : ""}`;
    let ok = false;
    if (whatsappEnabled() && primaryNumber()) ok = await deliverWhatsApp(primaryNumber()!, text);
    if (!ok) ok = await sendTelegram(text);
    return ok ? "alerte envoyée" : "Error: aucun canal (WhatsApp/Telegram) n'a accepté l'alerte — note-la dans le rapport";
  },
});
