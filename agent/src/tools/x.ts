import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";

/**
 * Veille X (Twitter) via l'API officielle v2 « recent search ».
 * FAIT : le scraping de x.com sans API viole les CGU et se fait bloquer en
 * quelques heures (Cloudflare + empreinte navigateur). L'API Basic (~100 USD/mois
 * en 2026, à revérifier sur developer.x.com) donne 10 000 tweets lus/mois,
 * largement assez pour une veille quotidienne ciblée.
 */

type Tweet = { id: string; text: string; created_at?: string; author_id?: string; public_metrics?: Record<string, number> };
type User = { id: string; username: string; name: string };

export const xSearchTool = betaZodTool({
  name: "x_search",
  description:
    "Recherche les tweets des 7 derniers jours via l'API X v2 (recent search). Syntaxe: opérateurs X (from:, -is:retweet, lang:fr, min_faves:). Retourne texte, auteur, date, métriques. Non disponible si X_BEARER_TOKEN absent.",
  inputSchema: z.object({
    query: z.string().min(2).max(500),
    max_results: z.number().int().min(10).max(100).default(30),
  }),
  run: async (i) => {
    const token = config().X_BEARER_TOKEN;
    if (!token) return "Error: X_BEARER_TOKEN non configuré — utilise web_search en repli.";
    const url = new URL("https://api.x.com/2/tweets/search/recent");
    url.searchParams.set("query", i.query);
    url.searchParams.set("max_results", String(i.max_results));
    url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id,lang");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username,name");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) return `Error: quota X atteint (reset: ${res.headers.get("x-rate-limit-reset") ?? "?"})`;
    if (!res.ok) return `Error: X API ${res.status} ${await res.text()}`;
    const data = (await res.json()) as { data?: Tweet[]; includes?: { users?: User[] } };
    const users = new Map((data.includes?.users ?? []).map((u) => [u.id, u]));
    if (!data.data?.length) return "aucun tweet";
    return data.data
      .map((t) => {
        const u = t.author_id ? users.get(t.author_id) : undefined;
        const m = t.public_metrics ?? {};
        return `- @${u?.username ?? "?"} (${t.created_at?.slice(0, 16) ?? ""}) ♥${m.like_count ?? 0} ↻${m.retweet_count ?? 0}\n  ${t.text.replace(/\s+/g, " ").trim()}\n  https://x.com/i/status/${t.id}`;
      })
      .join("\n");
  },
});
