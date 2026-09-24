import { config } from "../config.js";
import { structured, resolveModelAsync } from "../llm.js";
import { logger } from "../logger.js";
import { REPORT_SYSTEM } from "../prompts.js";
import { episodesSince, spentToday, saveReport, markReportDelivered, memoryDigest } from "../memory/store.js";
import { mcpToolsFor } from "../mcp/registry.js";
import { sendTelegram } from "../tools/notify.js";
import { deliverWhatsApp, primaryNumber, whatsappEnabled } from "../channels/whatsapp.js";

/**
 * Rapport du matin : un seul appel structuré (pas d'outils, pas de boucle),
 * alimenté par le journal des missions des 24 dernières heures + la mémoire.
 * Coût typique : 0,05-0,15 USD.
 */

type Report = {
  title: string;
  summary: string;
  highlights: Array<{ fact: string; impact: string; source?: string }>;
  done: string[];
  awaiting_human: string[];
  failures_risks: string[];
  spend_usd: number;
  top_priority: { action: string; why: string };
};

const SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary", "highlights", "done", "awaiting_human", "failures_risks", "spend_usd", "top_priority"],
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      highlights: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["fact", "impact"],
          properties: { fact: { type: "string" }, impact: { type: "string" }, source: { type: "string" } },
        },
      },
      done: { type: "array", items: { type: "string" } },
      awaiting_human: { type: "array", items: { type: "string" } },
      failures_risks: { type: "array", items: { type: "string" } },
      spend_usd: { type: "number" },
      top_priority: {
        type: "object",
        additionalProperties: false,
        required: ["action", "why"],
        properties: { action: { type: "string" }, why: { type: "string" } },
      },
    },
  },
};

export async function buildAndDeliverReport(): Promise<string> {
  const cfg = config();
  const episodes = await episodesSince(24);
  const spent = await spentToday();
  const memory = await memoryDigest(20_000);

  const prompt = `Date: ${new Date().toISOString()}
Dépense LLM cumulée aujourd'hui: ${spent.toFixed(2)} USD (plafond ${cfg.DAILY_BUDGET_USD} USD).

<missions_24h>
${episodes.map((e) => `## ${e.mission} — ${e.status} — ${Number(e.usd).toFixed(2)} USD — ${e.started_at}\n${e.summary ?? ""}${e.error ? `\nERREUR: ${e.error}` : ""}`).join("\n\n") || "(aucune mission)"}
</missions_24h>

<memoire>
${memory}
</memoire>`;

  const { value, usd } = await structured<Report>({ ...(await resolveModelAsync("worker")), system: REPORT_SYSTEM, prompt, schema: SCHEMA, effort: "medium" });
  const md = render(value);
  await saveReport(md);

  // Livraison : WhatsApp (canal principal) → Gmail via MCP → Telegram (secours).
  let delivered = false;
  if (whatsappEnabled() && primaryNumber()) {
    delivered = await deliverWhatsApp(primaryNumber()!, md).catch((e) => (logger.error({ err: String(e) }, "whatsapp rapport"), false));
  }
  const gmail = mcpToolsFor(["gmail"], { allowIrreversible: true }).find((t) => /send/i.test(t.name));
  if (gmail && cfg.REPORT_TO_EMAIL) {
    try {
      await gmail.run({ to: [cfg.REPORT_TO_EMAIL], subject: value.title, body: md, mimeType: "text/plain" });
      delivered = true;
    } catch (err) {
      logger.error({ err: String(err) }, "envoi Gmail échoué");
    }
  }
  if (await sendTelegram(md)) delivered = true;
  if (delivered) await markReportDelivered();
  logger.info({ delivered, usd: usd.toFixed(3) }, "rapport du matin");
  return md;
}

function render(r: Report): string {
  const li = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (rien)");
  return `# ${r.title}

${r.summary}

## Faits marquants
${r.highlights.map((h) => `- ${h.fact} → ${h.impact}${h.source ? ` (${h.source})` : ""}`).join("\n") || "- (rien)"}

## Fait cette nuit
${li(r.done)}

## En attente de ta validation
${li(r.awaiting_human)}

## Échecs / risques
${li(r.failures_risks)}

## Priorité n°1 aujourd'hui
**${r.top_priority.action}** — ${r.top_priority.why}

Dépense LLM : ${r.spend_usd.toFixed(2)} USD`;
}
