import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { sandboxExec, formatExec, shellQuote } from "./sandbox.js";

/**
 * Audit de site en un appel : Lighthouse (performance, SEO, accessibilité,
 * bonnes pratiques) + extraction SEO/GEO structurée (title, meta, Hn, canonical,
 * hreflang, robots, JSON-LD, Open Graph, liens internes/externes, taille HTML).
 * Tout tourne dans le sandbox (Chromium déjà présent). Sortie compacte pour le modèle.
 */
export function makeAuditTool(container?: string) {
  return betaZodTool({
    name: "site_audit",
    description:
      "Audite une URL : scores Lighthouse (perf/SEO/a11y/best-practices, mobile par défaut), Core Web Vitals lab, principales opportunités, et checklist SEO/GEO (title, description, H1, canonical, hreflang, robots, JSON-LD, OG, liens). Coût : 30-60 s par URL.",
    inputSchema: z.object({
      url: z.string().url(),
      device: z.enum(["mobile", "desktop"]).default("mobile"),
      lighthouse: z.boolean().default(true).describe("false pour ne faire que la checklist SEO (rapide)"),
    }),
    run: async (i) => {
      const work = config().SANDBOX_WORKDIR;
      const out: string[] = [];

      if (i.lighthouse) {
        const lh = await sandboxExec(
          `cd ${work} && lighthouse ${shellQuote(i.url)} --quiet --chrome-flags="--headless=new --no-sandbox --disable-gpu" --output=json --output-path=stdout ${i.device === "desktop" ? "--preset=desktop" : ""} --only-categories=performance,seo,accessibility,best-practices 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const c=r.categories;const a=r.audits;
const pick=k=>a[k]?.displayValue??"?";
const opps=Object.values(a).filter(x=>x.details&&x.details.type==="opportunity"&&x.score!==null&&x.score<0.9).sort((x,y)=>(y.details.overallSavingsMs||0)-(x.details.overallSavingsMs||0)).slice(0,6).map(x=>"- "+x.title+" (~"+Math.round(x.details.overallSavingsMs||0)+" ms)");
const seoFails=Object.values(a).filter(x=>r.categories.seo.auditRefs.some(ref=>ref.id===x.id)&&x.score!==null&&x.score<1).map(x=>"- "+x.title);
console.log(JSON.stringify({scores:{perf:Math.round(c.performance.score*100),seo:Math.round(c.seo.score*100),a11y:Math.round(c.accessibility.score*100),bp:Math.round(c["best-practices"].score*100)},vitals:{LCP:pick("largest-contentful-paint"),CLS:pick("cumulative-layout-shift"),TBT:pick("total-blocking-time"),FCP:pick("first-contentful-paint"),SI:pick("speed-index")},opportunities:opps,seoFails}))})'`,
          { timeoutMs: 180_000, container },
        );
        out.push(lh.code === 0 && lh.stdout.trim() ? `LIGHTHOUSE (${i.device}): ${lh.stdout.trim()}` : `LIGHTHOUSE: échec\n${formatExec(lh).slice(0, 1500)}`);
      }

      const script = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; ManziAudit/1.0)' });
  const res = await page.goto(${JSON.stringify(i.url)}, { waitUntil: 'networkidle', timeout: 45000 });
  const data = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const txt = (el) => (el ? (el.getAttribute('content') || el.textContent || '').trim() : null);
    const jsonld = qa('script[type="application/ld+json"]').map(s => { try { const j = JSON.parse(s.textContent); return j['@type'] || (j['@graph']||[]).map(g=>g['@type']).join('+') || 'unknown'; } catch { return 'INVALID_JSON'; } });
    const links = qa('a[href]').map(a => a.href);
    const host = location.host;
    const words = document.body.innerText.split(/\\s+/).filter(Boolean).length;
    return {
      title: document.title, titleLen: document.title.length,
      description: txt(q('meta[name="description"]')), descLen: (txt(q('meta[name="description"]'))||'').length,
      canonical: q('link[rel="canonical"]')?.href || null,
      robots: txt(q('meta[name="robots"]')), lang: document.documentElement.lang || null,
      hreflang: qa('link[rel="alternate"][hreflang]').map(l => l.hreflang),
      h1: qa('h1').map(h => h.textContent.trim()), h2Count: qa('h2').length, h3Count: qa('h3').length,
      jsonld, og: { title: txt(q('meta[property="og:title"]')), image: txt(q('meta[property="og:image"]')) },
      imagesWithoutAlt: qa('img').filter(i => !i.alt).length, imagesTotal: qa('img').length,
      internalLinks: links.filter(l => l.includes(host)).length, externalLinks: links.filter(l => !l.includes(host) && l.startsWith('http')).length,
      words, hasFaq: /\\bFAQ\\b|questions fréquentes/i.test(document.body.innerText),
      viewport: !!q('meta[name="viewport"]'),
    };
  });
  const status = res ? res.status() : null;
  const html = await page.content();
  console.log(JSON.stringify({ status, htmlKB: Math.round(html.length / 1024), ...data }));
  await browser.close();
})().catch(e => { console.error(String(e)); process.exit(2); });`;
      const seo = await sandboxExec(`cd ${work} && node -e ${shellQuote(script)}`, { timeoutMs: 90_000, container });
      out.push(seo.code === 0 ? `SEO/GEO: ${seo.stdout.trim()}` : `SEO/GEO: échec\n${formatExec(seo).slice(0, 1500)}`);

      // robots.txt / sitemap / llms.txt : signaux d'indexabilité et de GEO.
      const origin = new URL(i.url).origin;
      const probes = await Promise.all(
        ["/robots.txt", "/sitemap.xml", "/llms.txt"].map(async (p) => {
          try {
            const r = await fetch(origin + p, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10_000) });
            return `${p}: ${r.status}${r.ok ? ` (${(await r.text()).length} car.)` : ""}`;
          } catch {
            return `${p}: injoignable`;
          }
        }),
      );
      out.push(`FICHIERS: ${probes.join(" | ")}`);
      return out.join("\n\n");
    },
  });
}

export const auditTool = makeAuditTool();
