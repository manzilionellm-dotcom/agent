import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { untrusted } from "../safety.js";

/**
 * Recherche temps réel côté client : Tavily (par défaut) ou SerpAPI.
 * Ce sont des outils « client », donc utilisables avec N'IMPORTE QUEL modèle
 * (Claude, DeepSeek, Kimi, Qwen…). Avec Claude, web_search/web_fetch serveur
 * restent disponibles en plus ; l'agent choisit.
 *
 * FAIT à connaître : ni Tavily ni SerpAPI n'indexent les posts X (Twitter).
 * Pour X, seule l'API officielle v2 fonctionne de façon fiable (voir x.ts).
 */

export const tavilySearchTool = betaZodTool({
  name: "tavily_search",
  description:
    "Recherche web temps réel (Tavily). Retourne titre, URL, extrait et parfois une réponse synthétique. topic='news' pour l'actualité récente avec filtre de fraîcheur.",
  inputSchema: z.object({
    query: z.string().min(2).max(400),
    topic: z.enum(["general", "news"]).default("general"),
    days: z.number().int().min(1).max(30).default(7).describe("Fraîcheur max en jours (topic=news)"),
    max_results: z.number().int().min(1).max(20).default(8),
    include_domains: z.array(z.string()).optional(),
    search_depth: z.enum(["basic", "advanced"]).default("basic"),
  }),
  run: async (i) => {
    const key = config().TAVILY_API_KEY;
    if (!key) return "Error: TAVILY_API_KEY non configuré";
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query: i.query,
        topic: i.topic,
        days: i.topic === "news" ? i.days : undefined,
        max_results: i.max_results,
        include_domains: i.include_domains,
        search_depth: i.search_depth,
        include_answer: true,
      }),
    });
    if (!res.ok) return `Error: Tavily ${res.status} ${await res.text()}`;
    const data = (await res.json()) as { answer?: string; results?: Array<{ title: string; url: string; content: string; published_date?: string; score?: number }> };
    const lines = (data.results ?? []).map((r) => `- ${r.title}${r.published_date ? ` (${r.published_date.slice(0, 10)})` : ""}\n  ${r.url}\n  ${r.content.replace(/\s+/g, " ").slice(0, 500)}`);
    return untrusted("tavily:" + i.query, `${data.answer ? `Réponse synthétique: ${data.answer}\n\n` : ""}${lines.join("\n") || "aucun résultat"}`);
  },
});

export const tavilyExtractTool = betaZodTool({
  name: "tavily_extract",
  description: "Extrait le contenu principal (markdown) d'une ou plusieurs URL via Tavily. Plus robuste qu'un fetch brut sur les pages JS.",
  inputSchema: z.object({
    urls: z.array(z.string().url()).min(1).max(5),
    max_chars_per_url: z.number().int().min(500).max(40_000).default(12_000),
  }),
  run: async (i) => {
    const key = config().TAVILY_API_KEY;
    if (!key) return "Error: TAVILY_API_KEY non configuré";
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ urls: i.urls, format: "markdown" }),
    });
    if (!res.ok) return `Error: Tavily ${res.status} ${await res.text()}`;
    const data = (await res.json()) as { results?: Array<{ url: string; raw_content: string }>; failed_results?: Array<{ url: string; error: string }> };
    const ok = (data.results ?? []).map((r) => `## ${r.url}\n${r.raw_content.slice(0, i.max_chars_per_url)}`);
    const ko = (data.failed_results ?? []).map((r) => `## ${r.url}\nÉCHEC: ${r.error}`);
    return untrusted(i.urls.join(", "), [...ok, ...ko].join("\n\n") || "aucun contenu");
  },
});

export const serpapiSearchTool = betaZodTool({
  name: "serpapi_search",
  description: "Recherche Google via SerpAPI (résultats organiques, actualités, People Also Ask). Utile pour les SERP SEO : positions, concurrents, questions.",
  inputSchema: z.object({
    query: z.string().min(2).max(400),
    engine: z.enum(["google", "google_news"]).default("google"),
    gl: z.string().default("fr"),
    hl: z.string().default("fr"),
    num: z.number().int().min(1).max(20).default(10),
  }),
  run: async (i) => {
    const key = config().SERPAPI_API_KEY;
    if (!key) return "Error: SERPAPI_API_KEY non configuré";
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", i.engine);
    url.searchParams.set("q", i.query);
    url.searchParams.set("gl", i.gl);
    url.searchParams.set("hl", i.hl);
    url.searchParams.set("num", String(i.num));
    url.searchParams.set("api_key", key);
    const res = await fetch(url);
    if (!res.ok) return `Error: SerpAPI ${res.status}`;
    const data = (await res.json()) as {
      organic_results?: Array<{ position: number; title: string; link: string; snippet?: string; date?: string }>;
      news_results?: Array<{ title: string; link: string; snippet?: string; date?: string; source?: string }>;
      related_questions?: Array<{ question: string }>;
    };
    const org = (data.organic_results ?? []).map((r) => `${r.position}. ${r.title}\n   ${r.link}\n   ${r.snippet ?? ""}${r.date ? ` (${r.date})` : ""}`);
    const news = (data.news_results ?? []).map((r) => `- ${r.title} — ${r.source ?? ""} ${r.date ?? ""}\n  ${r.link}\n  ${r.snippet ?? ""}`);
    const paa = (data.related_questions ?? []).map((q) => `? ${q.question}`);
    return untrusted("serpapi:" + i.query, [org.join("\n"), news.join("\n"), paa.length ? `Questions associées:\n${paa.join("\n")}` : ""].filter(Boolean).join("\n\n") || "aucun résultat");
  },
});

/** Outils de recherche disponibles selon les clés configurées. */
export function searchTools() {
  const cfg = config();
  const out = [];
  if (cfg.TAVILY_API_KEY) out.push(tavilySearchTool, tavilyExtractTool);
  if (cfg.SERPAPI_API_KEY) out.push(serpapiSearchTool);
  return out;
}
