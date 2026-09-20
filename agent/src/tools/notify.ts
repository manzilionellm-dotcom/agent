import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Livraison du rapport : Telegram (fiable, gratuit, instantané sur mobile)
 * et/ou Gmail via le serveur MCP (outil `gmail_send_email` exposé au modèle).
 * Telegram est le canal de secours : si Gmail échoue, tu reçois quand même.
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
    const ok = await sendTelegram(`${icon} ${i.title}\n\n${i.body}${i.source_url ? `\n\n${i.source_url}` : ""}`);
    return ok ? "alerte envoyée" : "Error: Telegram non configuré ou échec d'envoi — note l'alerte dans le rapport";
  },
});
