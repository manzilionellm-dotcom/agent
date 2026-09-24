import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AgentRunOptions, AgentRunResult, Usage } from "../llm.js";

/**
 * Boucle agentique pour tout endpoint compatible OpenAI (DeepSeek, Moonshot/Kimi,
 * Qwen via DashScope, OpenRouter, vLLM/Ollama local).
 *
 * Ce qu'on PERD par rapport à Claude, à savoir avant de basculer :
 *   - les outils serveur (web_search/web_fetch) → remplacés par Tavily/SerpAPI ;
 *   - la compaction serveur → on tronque les vieux résultats d'outils nous-mêmes ;
 *   - le fallback sur refus, le cache 1h explicite (DeepSeek a un cache implicite) ;
 *   - la fiabilité des appels d'outils sur de longues séquences (INFÉRENCE, à mesurer sur
 *     vos propres missions : comptez les tours en erreur par mission).
 */

type ToolLike = BetaRunnableTool<any> | Anthropic.Beta.Messages.BetaToolUnion;

const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", enum: ["view", "create", "str_replace", "insert", "delete", "rename"] },
    path: { type: "string" },
    file_text: { type: "string" },
    old_str: { type: "string" },
    new_str: { type: "string" },
    insert_line: { type: "integer" },
    insert_text: { type: "string" },
    old_path: { type: "string" },
    new_path: { type: "string" },
    view_range: { type: "array", items: { type: "integer" } },
  },
  required: ["command"],
};

function isRunnable(t: ToolLike): t is BetaRunnableTool<any> {
  return typeof (t as BetaRunnableTool<any>).run === "function";
}

function toOpenAITool(t: BetaRunnableTool<any>): OpenAI.Chat.Completions.ChatCompletionTool {
  const anyT = t as unknown as { name: string; description?: string; input_schema?: Record<string, unknown>; type?: string };
  const parameters = anyT.type === "memory_20250818" ? MEMORY_SCHEMA : (anyT.input_schema ?? { type: "object", properties: {} });
  return {
    type: "function",
    function: {
      name: anyT.name,
      description: anyT.description ?? (anyT.type === "memory_20250818" ? "Mémoire persistante sous /memories (view/create/str_replace/insert/delete/rename)." : ""),
      parameters,
    },
  };
}

export type Prix = { in: number; out: number; cache?: number };

/**
 * Grille de prix intégrée, USD par million de jetons, heures pleines (le
 * pire cas : DeepSeek fait moitié prix en heures creuses, on ne compte pas
 * dessus). Lue sur api-docs.deepseek.com/quick_start/pricing le 24/09/2026.
 *
 * Sans elle, un modèle inconnu du .env était compté 1 $ / 3 $ le million —
 * six fois le vrai prix de deepseek-flash. Le compteur du jour atteignait le
 * plafond avec de l'argent jamais dépensé, et les missions se faisaient
 * couper pour rien.
 */
export const PRIX_CONNUS: Record<string, Prix> = {
  "deepseek-flash": { in: 0.3, out: 1.2, cache: 0.006 },
  "deepseek-v4-pro": { in: 1.32, out: 3.96, cache: 0.044 },
  // Anciens noms DeepSeek, encore dans des .env : mêmes ordres de grandeur.
  "deepseek-chat": { in: 0.3, out: 1.2, cache: 0.006 },
  "deepseek-reasoner": { in: 1.32, out: 3.96, cache: 0.044 },
};

const PRIX_INCONNU: Prix = { in: 1, out: 3 };
const avertis = new Set<string>();

/** Le .env (MODEL_PRICES) passe devant la grille intégrée : c'est lui qu'on met à jour quand un prix change. */
export function prixDe(model: string): Prix {
  const env = parsePrices()[model];
  if (env) return { ...env, cache: PRIX_CONNUS[model]?.cache ?? env.in / 10 };
  const connu = PRIX_CONNUS[model];
  if (connu) return connu;
  if (!avertis.has(model)) {
    avertis.add(model);
    logger.warn({ model }, "prix inconnu : compté 1 $ / 3 $ le million — ajoute-le à MODEL_PRICES pour un compteur juste");
  }
  return PRIX_INCONNU;
}

/**
 * Coût d'un appel, cache compris. DeepSeek renvoie `prompt_cache_hit_tokens`
 * (son propre nom) ; les autres endpoints compatibles OpenAI mettent la même
 * chose dans `prompt_tokens_details.cached_tokens`. Un jeton lu depuis le
 * cache coûte cinquante fois moins qu'un jeton neuf : l'ignorer, c'est
 * surcompter chaque tour d'une longue mission, dont le préambule est
 * toujours en cache.
 */
export function coutAppel(model: string, u: OpenAI.Completions.CompletionUsage | undefined): { usd: number; caches: number } {
  if (!u) return { usd: 0, caches: 0 };
  const p = prixDe(model);
  const brut = u as { prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  const caches = Math.max(0, Math.min(u.prompt_tokens ?? 0, brut.prompt_cache_hit_tokens ?? brut.prompt_tokens_details?.cached_tokens ?? 0));
  const neufs = (u.prompt_tokens ?? 0) - caches;
  const usd = (neufs * p.in + caches * (p.cache ?? p.in / 10) + (u.completion_tokens ?? 0) * p.out) / 1_000_000;
  return { usd, caches };
}

function parsePrices(): Record<string, { in: number; out: number }> {
  const out: Record<string, { in: number; out: number }> = {};
  for (const part of config().MODEL_PRICES.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [model, prices] = part.split("=");
    const [i, o] = (prices ?? "").split("/").map(Number);
    if (model && Number.isFinite(i) && Number.isFinite(o)) out[model] = { in: i!, out: o! };
  }
  return out;
}

export function estDeepSeek(baseUrl: string | undefined): boolean {
  return /deepseek\.com/i.test(baseUrl ?? "");
}

export type Reflexion = "eco" | "auto" | "max";
export const REFLEXIONS: Record<Reflexion, string> = {
  eco: "réfléchit peu partout : réponses plus rapides, moins chères",
  auto: "réfléchit peu en conversation, à fond pour planifier et coder (recommandé)",
  max: "réfléchit à fond partout, y compris en conversation : plus lent, plus cher",
};

/**
 * Options propres à DeepSeek, vérifiées dans sa référence d'API (le 24/09) :
 * `thinking` est activé PAR DÉFAUT sur deepseek-flash et deepseek-v4-pro,
 * avec `reasoning_effort` « high ». Ne rien envoyer, c'est donc payer une
 * longue réflexion à chaque « ok » de conversation. On règle l'effort selon
 * la nature du travail : peu pour bavarder et faire tourner des outils,
 * beaucoup pour planifier une mission ou écrire du code. Les valeurs
 * acceptées sont none / low / high / max.
 *
 * Les jetons de réflexion comptent dans `max_tokens` : on laisse plus de
 * place quand l'effort est grand, sinon le modèle se fait couper avant sa
 * réponse.
 */
export function optionsDeepSeek(kind: AgentRunOptions["kind"], reflexion: Reflexion): { reasoning_effort: "low" | "high" | "max"; max_tokens: number } {
  const table: Record<Reflexion, Record<NonNullable<AgentRunOptions["kind"]>, "low" | "high" | "max">> = {
    eco: { chat: "low", worker: "low", planner: "low", critical: "high" },
    auto: { chat: "low", worker: "low", planner: "high", critical: "high" },
    max: { chat: "high", worker: "high", planner: "max", critical: "max" },
  };
  const effort = table[reflexion][kind ?? "worker"];
  return { reasoning_effort: effort, max_tokens: effort === "low" ? 16_000 : effort === "high" ? 32_000 : 64_000 };
}

export async function reflexionReglee(): Promise<Reflexion> {
  try {
    const { setting } = await import("../providers.js");
    const v = await setting("REFLEXION");
    return v === "eco" || v === "max" ? v : "auto";
  } catch {
    return "auto";
  }
}

const MAX_TOOL_RESULT_CHARS = 30_000;
const KEEP_RECENT_TOOL_RESULTS = 12;

export async function runOpenAICompat(opts: AgentRunOptions): Promise<AgentRunResult> {
  const cfg = config();
  // L'endpoint peut être surchargé par appel : deux fournisseurs compatibles
  // OpenAI (Mistral et DeepSeek) coexistent alors dans la même installation.
  const client = new OpenAI({
    baseURL: opts.baseUrl ?? cfg.OPENAI_COMPAT_BASE_URL,
    apiKey: opts.apiKey ?? cfg.OPENAI_COMPAT_API_KEY,
    maxRetries: 4,
    timeout: 20 * 60_000,
  });
  const budget = opts.budgetUsd ?? cfg.MISSION_BUDGET_USD;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, iterations: 0 };
  const deepseek = estDeepSeek(opts.baseUrl ?? cfg.OPENAI_COMPAT_BASE_URL);
  const extra = deepseek ? optionsDeepSeek(opts.kind, await reflexionReglee()) : undefined;

  const runnable = opts.tools.filter(isRunnable);
  const skipped = opts.tools.filter((t) => !isRunnable(t)).map((t) => (t as { name?: string }).name);
  if (skipped.length) logger.warn({ skipped }, "outils serveur Anthropic ignorés avec openai_compat");
  const byName = new Map(runnable.map((t) => [t.name, t]));
  const tools = runnable.map(toOpenAITool);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.task },
  ];
  let finalText = "";
  let stop: AgentRunResult["stopReason"] = "end_turn";
  const callCounts = new Map<string, number>();

  for (let iter = 0; iter < (opts.maxIterations ?? 60); iter++) {
    if (opts.signal?.aborted) {
      stop = "timeout";
      break;
    }
    const res = await client.chat.completions.create({
      model: opts.model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      max_tokens: extra?.max_tokens ?? 16_000,
      ...(extra ? { reasoning_effort: extra.reasoning_effort } : {}),
    });
    usage.iterations += 1;
    usage.inputTokens += res.usage?.prompt_tokens ?? 0;
    usage.outputTokens += res.usage?.completion_tokens ?? 0;
    const cout = coutAppel(opts.model, res.usage);
    usage.cacheReadTokens += cout.caches;
    usage.usd += cout.usd;

    const choice = res.choices[0];
    if (!choice) break;
    const msg = choice.message;
    // DeepSeek en mode réflexion renvoie `reasoning_content` ; le lui rendre
    // dans le tour suivant garde le fil de sa pensée entre deux appels
    // d'outils. Les autres endpoints ne connaissent pas le champ : on ne
    // l'envoie qu'à lui.
    const raisonnement = (msg as { reasoning_content?: string | null }).reasoning_content;
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
      ...(deepseek && raisonnement && msg.tool_calls?.length ? { reasoning_content: raisonnement } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    if (msg.content) finalText = msg.content;

    await opts.onTurn?.(
      { stop_reason: msg.tool_calls?.length ? "tool_use" : "end_turn", model: opts.model } as unknown as Anthropic.Beta.Messages.BetaMessage,
      usage,
    );

    if (!msg.tool_calls?.length) {
      if (choice.finish_reason === "length") stop = "max_tokens";
      break;
    }
    let looping = false;
    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue;
      const key = call.function.name + call.function.arguments;
      const n = (callCounts.get(key) ?? 0) + 1;
      callCounts.set(key, n);
      if (n >= 3) looping = true;
    }
    if (looping) {
      logger.warn("boucle détectée (openai_compat) — arrêt");
      stop = "loop_detected";
      break;
    }

    // Exécution parallèle des appels d'outils, tous les résultats renvoyés dans l'ordre.
    const results = await Promise.all(
      msg.tool_calls.map(async (call) => {
        if (call.type !== "function") return { id: call.id, content: "Error: type d'appel non supporté" };
        const tool = byName.get(call.function.name);
        if (!tool) return { id: call.id, content: `Error: outil inconnu ${call.function.name}` };
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          const out = await tool.run(tool.parse(args));
          const text = typeof out === "string" ? out : JSON.stringify(out);
          return { id: call.id, content: text.slice(0, MAX_TOOL_RESULT_CHARS) };
        } catch (err) {
          return { id: call.id, content: `Error: ${String(err).slice(0, 2000)}` };
        }
      }),
    );
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });

    // Compaction locale : on résume les vieux résultats d'outils pour tenir dans le contexte.
    pruneOldToolResults(messages);

    if (usage.usd > budget) {
      stop = "budget_exceeded";
      break;
    }
  }

  return { finalText, stopReason: stop, usage, messages: [] };
}

function pruneOldToolResults(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void {
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const old = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_TOOL_RESULTS));
  for (const i of old) {
    const m = messages[i];
    if (m && m.role === "tool" && typeof m.content === "string" && m.content.length > 400) {
      m.content = m.content.slice(0, 300) + "\n…[résultat ancien tronqué]";
    }
  }
}

export async function structuredOpenAICompat<T>(opts: { model: string; system: string; prompt: string; schema: Record<string, unknown>; baseUrl?: string; apiKey?: string }): Promise<{ value: T; usd: number }> {
  const cfg = config();
  const client = new OpenAI({ baseURL: opts.baseUrl ?? cfg.OPENAI_COMPAT_BASE_URL, apiKey: opts.apiKey ?? cfg.OPENAI_COMPAT_API_KEY, maxRetries: 3 });
  // Une extraction JSON n'a pas besoin de réflexion longue : « low » chez DeepSeek.
  const deepseek = estDeepSeek(opts.baseUrl ?? cfg.OPENAI_COMPAT_BASE_URL);
  const res = await client.chat.completions.create({
    model: opts.model,
    messages: [
      { role: "system", content: `${opts.system}\n\nRéponds UNIQUEMENT avec un objet JSON valide conforme à ce schéma JSON:\n${JSON.stringify(opts.schema)}` },
      { role: "user", content: opts.prompt },
    ],
    response_format: { type: "json_object" },
    max_tokens: 8_000,
    ...(deepseek ? { reasoning_effort: "low" as const } : {}),
  });
  const text = res.choices[0]?.message.content ?? "{}";
  const usd = coutAppel(opts.model, res.usage).usd;
  return { value: JSON.parse(text) as T, usd };
}
