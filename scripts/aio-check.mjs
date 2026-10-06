#!/usr/bin/env node
// Preuve "HTML brut sans JS". Usage: node scripts/aio-check.mjs <url|fichier.html> [--json]
// Vérifie : Citation Hooks (h2/h3 question -> <p> suivant 40–60 mots), JSON-LD (parse + FAQPage/Product/HowTo),
// <img> sans alt, <video> sans transcription, présence llms.txt (si URL).
import fs from "node:fs";
const target = process.argv[2];
if (!target) { console.error("usage: aio-check <url|file>"); process.exit(2); }
const html = /^https?:/.test(target) ? await (await fetch(target, { headers: { "user-agent": "aio-check (no-JS)" } })).text() : fs.readFileSync(target, "utf8");
const decode = (s) => s.replace(/<!--.*?-->/gs, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const wc = (s) => [(s.match(/\S+/g) || []).length, (s.match(/[\p{L}\p{N}€$%]+(?:['’][\p{L}]+)?/gu) || []).length];
const res = { hooks: [], jsonld: [], problems: [] };
const noScript = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
const re = /<(h[23])\b[^>]*>([\s\S]*?)<\/\1>\s*(?:<!--.*?-->\s*)*<p\b[^>]*>([\s\S]*?)<\/p>/g;
let m;
while ((m = re.exec(noScript))) {
  const q = decode(m[2]);
  if (!/\?\s*$/.test(q)) continue;
  const a = decode(m[3]);
  const [w1, w2] = wc(a);
  const ok = w1 >= 40 && w1 <= 60 && w2 >= 40 && w2 <= 60;
  res.hooks.push({ tag: m[1], q, words: w1, wordsAlt: w2, ok });
  if (!ok) res.problems.push(`Citation Hook hors 40–60 mots (${w1}/${w2}): ${q}`);
}
// titres question non suivis directement d'un <p>
const qHeads = [...noScript.matchAll(/<(h[23])\b[^>]*>([\s\S]*?)<\/\1>/g)].map((x) => decode(x[2])).filter((q) => /\?\s*$/.test(q));
for (const q of qHeads) if (!res.hooks.find((h) => h.q === q)) res.problems.push(`Titre question sans <p> immédiat: ${q}`);
if (!res.hooks.length) res.problems.push("Aucun Citation Hook trouvé");
for (const s of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
  try {
    const j = JSON.parse(s[1]);
    const nodes = j["@graph"] || (Array.isArray(j) ? j : [j]);
    for (const n of nodes) res.jsonld.push({ type: n["@type"], name: n.name || (n.mainEntity ? n.mainEntity.length + " questions" : undefined) });
    for (const n of nodes) if (n["@type"] === "FAQPage") {
      for (const q of n.mainEntity || []) if (!decode(noScript).includes(decode(q.acceptedAnswer.text).slice(0, 60))) res.problems.push("FAQ JSON-LD non visible dans le DOM: " + q.name);
    }
  } catch (e) { res.problems.push("JSON-LD invalide: " + e.message); }
}
if (!res.jsonld.length) res.problems.push("Aucun JSON-LD dans le HTML brut");
const imgs = [...noScript.matchAll(/<img\b[^>]*>/g)].map((x) => x[0]);
res.images = imgs.length;
for (const t of imgs) { const a = t.match(/\balt="([^"]*)"/); if (!a || a[1].trim().length < 8 || /^(image|img|photo)?\d*(\.\w+)?$/i.test(a[1].trim())) res.problems.push("alt absent/non descriptif: " + t.slice(0, 80)); }
const vids = (noScript.match(/<video\b/g) || []).length + (noScript.match(/<iframe[^>]+(youtube|vimeo)/g) || []).length;
res.videos = vids;
if (vids && !/data-aio-transcript|class="[^"]*aio-transcript/.test(noScript)) res.problems.push("vidéo sans bloc transcription (.aio-transcript)");
if (/^https?:/.test(target)) { const o = new URL(target).origin; const r = await fetch(o + "/llms.txt"); res.llmsTxt = r.status; if (r.status !== 200) res.problems.push("/llms.txt → " + r.status); }
console.log(JSON.stringify(res, null, 2));
process.exit(res.problems.length ? 1 : 0);
