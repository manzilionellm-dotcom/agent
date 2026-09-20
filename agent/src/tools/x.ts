import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { sandboxExec, shellQuote } from "./sandbox.js";
import { untrusted } from "../safety.js";

/**
 * Lecture GRATUITE des profils X publics, sans API (best-effort, par ordre de fiabilité) :
 *   1. Endpoint de syndication (widgets « timeline » publics) — sans authentification,
 *      renvoie les derniers posts d'un profil public quand X le laisse ouvert.
 *   2. Chromium (Playwright) sur x.com/<user>, avec le cookie auth_token d'un compte
 *      secondaire si X_AUTH_TOKEN est fourni (sinon X exige souvent une connexion).
 *   3. Repli : recherche Tavily `site:x.com <user>` (index partiel, retard de quelques heures).
 *
 * VÉRITÉ à connaître : X bloque activement le scraping ; le taux de réussite varie
 * d'une semaine à l'autre, un compte utilisé pour scraper peut être suspendu, et les
 * CGU de X l'interdisent. Pour une veille concurrentielle, les sites web et flux RSS
 * des concurrents restent la source fiable ; X est un complément, jamais la base.
 */

const MAX_POSTS = 20;

type Post = { id?: string; text: string; date?: string; likes?: number; reposts?: number };

async function viaSyndication(user: string): Promise<Post[]> {
  const res = await fetch(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(user)}`, {
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36", "accept-language": "fr-FR,fr;q=0.9" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`syndication ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("syndication: pas de données");
  const data = JSON.parse(m[1]!) as { props?: { pageProps?: { timeline?: { entries?: Array<{ content?: { tweet?: Record<string, unknown> } }> } } } };
  const entries = data.props?.pageProps?.timeline?.entries ?? [];
  return entries
    .map((e) => e.content?.tweet)
    .filter((t): t is Record<string, unknown> => !!t)
    .slice(0, MAX_POSTS)
    .map((t) => ({
      id: String(t.id_str ?? ""),
      text: String(t.full_text ?? t.text ?? ""),
      date: t.created_at ? new Date(String(t.created_at)).toISOString().slice(0, 16) : undefined,
      likes: Number(t.favorite_count ?? 0),
      reposts: Number(t.retweet_count ?? 0),
    }));
}

async function viaChromium(user: string, container?: string): Promise<Post[]> {
  const cookie = config().X_AUTH_TOKEN;
  const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36', locale: 'fr-FR', viewport: { width: 1280, height: 2200 } });
  ${cookie ? `await ctx.addCookies([{ name: 'auth_token', value: ${JSON.stringify(cookie)}, domain: '.x.com', path: '/', httpOnly: true, secure: true }]);` : ""}
  const page = await ctx.newPage();
  await page.goto('https://x.com/' + ${JSON.stringify(user)}, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try { await page.waitForSelector('article', { timeout: 15000 }); } catch {}
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(800); }
  const posts = await page.$$eval('article', (els) => els.slice(0, ${MAX_POSTS}).map((a) => {
    const t = a.querySelector('[data-testid="tweetText"]');
    const time = a.querySelector('time');
    const link = a.querySelector('a[href*="/status/"]');
    const num = (sel) => { const el = a.querySelector(sel); const v = el && el.getAttribute('aria-label'); const m = v && v.match(/(\\d[\\d\\s,.]*)/); return m ? Number(m[1].replace(/[\\s,.]/g, '')) : 0; };
    return { id: link ? (link.getAttribute('href') || '').split('/status/')[1] : undefined, text: t ? t.innerText : '', date: time ? time.getAttribute('datetime') : undefined, likes: num('[data-testid="like"]'), reposts: num('[data-testid="retweet"]') };
  }));
  console.log(JSON.stringify(posts.filter(p => p.text)));
  await browser.close();
})().catch(e => { console.error(String(e)); process.exit(2); });`;
  const r = await sandboxExec(`cd ${config().SANDBOX_WORKDIR} && node -e ${shellQuote(script)}`, { timeoutMs: 120_000, container });
  if (r.code !== 0) throw new Error(`chromium: ${r.stderr.slice(-300)}`);
  return JSON.parse(r.stdout.trim() || "[]") as Post[];
}

async function viaTavily(user: string): Promise<Post[]> {
  const key = config().TAVILY_API_KEY;
  if (!key) throw new Error("tavily non configuré");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: `site:x.com/${user}`, max_results: 10, topic: "general", include_domains: ["x.com", "twitter.com"] }),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ url: string; content: string; published_date?: string }> };
  return (data.results ?? []).map((r) => ({ id: r.url.split("/status/")[1], text: r.content.slice(0, 500), date: r.published_date?.slice(0, 16) }));
}

export function makeXProfileTool(container?: string) {
  return betaZodTool({
    name: "x_profile",
    description:
      "Derniers posts publics d'un profil X (@user), sans API payante : syndication → Chromium → Tavily. Best-effort : peut échouer ou être incomplet ; si vide, ne conclus rien et note « X injoignable ». Ne jamais utiliser pour des comptes privés.",
    inputSchema: z.object({
      user: z.string().regex(/^[A-Za-z0-9_]{1,15}$/, "nom d'utilisateur X sans @"),
      max_posts: z.number().int().min(1).max(MAX_POSTS).default(10),
    }),
    run: async (i) => {
      const attempts: Array<[string, () => Promise<Post[]>]> = [
        ["syndication", () => viaSyndication(i.user)],
        ["chromium", () => viaChromium(i.user, container)],
        ["tavily", () => viaTavily(i.user)],
      ];
      const errors: string[] = [];
      for (const [name, fn] of attempts) {
        try {
          const posts = (await fn()).filter((p) => p.text.trim()).slice(0, i.max_posts);
          if (posts.length) {
            return untrusted(`x.com/${i.user}`, `source=${name} @${i.user} (${posts.length} posts)\n` + posts.map((p) => `- ${p.date ?? "?"} ♥${p.likes ?? "?"} ↻${p.reposts ?? "?"} ${p.text.replace(/\s+/g, " ").trim()}${p.id ? `\n  https://x.com/${i.user}/status/${p.id}` : ""}`).join("\n"));
          }
          errors.push(`${name}: vide`);
        } catch (e) {
          errors.push(`${name}: ${String(e).slice(0, 120)}`);
        }
      }
      return `X injoignable pour @${i.user} (${errors.join(" | ")}). Utilise le site web / RSS du concurrent.`;
    },
  });
}

export const xProfileTool = makeXProfileTool();
