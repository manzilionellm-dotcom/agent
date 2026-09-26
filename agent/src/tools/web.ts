import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { sandboxExec, formatExec, shellQuote } from "./sandbox.js";
import { masquerCles } from "./masque-cles.js";
import { untrusted } from "../safety.js";

/**
 * Trois niveaux de lecture du web, du moins cher au plus cher :
 *   1. web_search / web_fetch : outils SERVEUR Anthropic (pas d'infra, citations,
 *      filtrage dynamique). Suffisent pour 80 % de la veille.
 *   2. scrape_page : Playwright + Chromium dans le sandbox pour les pages JS
 *      (SPA, tarifs chargés en XHR, anti-bot léger).
 *   3. x_search : API officielle X v2 (voir x.ts).
 */

export const webSearchTool: Anthropic.Beta.Messages.BetaToolUnion = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 15,
};

export const webFetchTool: Anthropic.Beta.Messages.BetaToolUnion = {
  type: "web_fetch_20260209",
  name: "web_fetch",
  max_uses: 20,
  max_content_tokens: 30_000,
};

export function makeScrapeTool(container?: string) {
  return betaZodTool({
  name: "scrape_page",
  description:
    "Rend une page avec Chromium (Playwright) dans le sandbox et retourne son texte visible (ou un sélecteur CSS précis). À utiliser quand web_fetch renvoie une page vide/JS. Respecte robots.txt et n'insiste pas sur les sites qui bloquent.",
  inputSchema: z.object({
    url: z.string().url(),
    selector: z.string().optional().describe("Sélecteur CSS à extraire ; sinon tout le body"),
    wait_ms: z.number().int().min(0).max(15_000).default(1500),
    max_chars: z.number().int().min(500).max(60_000).default(20_000),
  }),
  run: async (i) => {
    const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36', locale: 'fr-FR' });
  const page = await ctx.newPage();
  await page.goto(${JSON.stringify(i.url)}, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(${i.wait_ms});
  const text = await page.evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : document.body;
    return el ? el.innerText : '';
  }, ${JSON.stringify(i.selector ?? null)});
  process.stdout.write(text.replace(/\\n{3,}/g, '\\n\\n').slice(0, ${i.max_chars}));
  await browser.close();
})().catch(e => { console.error(String(e)); process.exit(2); });
`;
    const r = await sandboxExec(`cd ${config().SANDBOX_WORKDIR} && node -e ${shellQuote(script)}`, { timeoutMs: 90_000, container });
    return r.code === 0 ? untrusted(i.url, masquerCles(r.stdout) || "(page vide)") : formatExec(r);
  },
  });
}

export const scrapePageTool = makeScrapeTool();
