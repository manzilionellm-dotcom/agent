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

function parsePrices(): Record<string, { in: number; out: number }> {
  const out: Record<string, { in: number; out: number }> = {};
  for (const part of config().MODEL_PRICES.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [model, prices] = part.split("=");
    const [i, o] = (prices ?? "").split("/").map(Number);
    if (model && Number.isFinite(i) && Number.isFinite(o)) out[model] = { in: i!, out: o! };
  }
  return out;
}

const MAX_TOOL_RESULT_CHARS = 30_000;
const KEEP_RECENT_TOOL_RESULTS = 12;

export async function runOpenAICompat(opts: AgentRunOptions): Promise<AgentRunResult> {
  const cfg = config();
  const client = new OpenAI({ baseURL: cfg.OPENAI_COMPAT_BASE_URL, apiKey: cfg.OPENAI_COMPAT_API_KEY, maxRetries: 4, timeout: 20 * 60_000 });
  const price = parsePrices()[opts.model] ?? { in: 1, out: 3 };
  const budget = opts.budgetUsd ?? cfg.MISSION_BUDGET_USD;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, iterations: 0 };

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

  for (let iter = 0; iter < (opts.maxIterations ?? 60); iter++) {
    if (opts.signal?.aborted) break;
    const res = await client.chat.completions.create({
      model: opts.model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      max_tokens: 16_000,
    });
    usage.iterations += 1;
    usage.inputTokens += res.usage?.prompt_tokens ?? 0;
    usage.outputTokens += res.usage?.completion_tokens ?? 0;
    usage.usd += ((res.usage?.prompt_tokens ?? 0) * price.in + (res.usage?.completion_tokens ?? 0) * price.out) / 1_000_000;

    const choice = res.choices[0];
    if (!choice) break;
    const msg = choice.message;
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (msg.content) finalText = msg.content;

    await opts.onTurn?.(
      { stop_reason: msg.tool_calls?.length ? "tool_use" : "end_turn", model: opts.model } as unknown as Anthropic.Beta.Messages.BetaMessage,
      usage,
    );

    if (!msg.tool_calls?.length) {
      if (choice.finish_reason === "length") stop = "max_tokens";
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

export async function structuredOpenAICompat<T>(opts: { model: string; system: string; prompt: string; schema: Record<string, unknown> }): Promise<{ value: T; usd: number }> {
  const cfg = config();
  const client = new OpenAI({ baseURL: cfg.OPENAI_COMPAT_BASE_URL, apiKey: cfg.OPENAI_COMPAT_API_KEY, maxRetries: 3 });
  const price = parsePrices()[opts.model] ?? { in: 1, out: 3 };
  const res = await client.chat.completions.create({
    model: opts.model,
    messages: [
      { role: "system", content: `${opts.system}\n\nRéponds UNIQUEMENT avec un objet JSON valide conforme à ce schéma JSON:\n${JSON.stringify(opts.schema)}` },
      { role: "user", content: opts.prompt },
    ],
    response_format: { type: "json_object" },
    max_tokens: 8_000,
  });
  const text = res.choices[0]?.message.content ?? "{}";
  const usd = ((res.usage?.prompt_tokens ?? 0) * price.in + (res.usage?.completion_tokens ?? 0) * price.out) / 1_000_000;
  return { value: JSON.parse(text) as T, usd };
}
