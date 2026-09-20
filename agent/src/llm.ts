import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Cœur LLM : une seule fonction `runAgent()` qui encapsule la boucle
 * plan → act → observe → verify du tool runner, avec :
 *   - compaction serveur (contexte illimité en pratique),
 *   - fallback serveur sur refus de sécurité,
 *   - cache de prompt (préfixe système stable),
 *   - comptage des tokens et arrêt sur budget dépassé,
 *   - reprise des `pause_turn` (outils serveur web_search / web_fetch).
 */

let _client: Anthropic | undefined;
export function client(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: config().ANTHROPIC_API_KEY,
      maxRetries: 4,
      timeout: 20 * 60_000, // ms — les tours agentiques longs dépassent 10 min
    });
  }
  return _client;
}

/** Prix publics Anthropic (USD / 1M tokens) au 2026-09. À revalider trimestriellement. */
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  iterations: number;
};

export function priceOf(model: string, u: Anthropic.Beta.Messages.BetaUsage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5"]!;
  return (
    (u.input_tokens * p.in +
      u.output_tokens * p.out +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentRunOptions = {
  model: string;
  system: string;
  /** Instruction de mission (tout le cahier des charges en une fois). */
  task: string;
  tools: (BetaRunnableTool<any> | Anthropic.Beta.Messages.BetaToolUnion)[];
  effort?: Effort;
  maxIterations?: number;
  budgetUsd?: number;
  /** Appelé après chaque tour ; permet journalisation / arrêt anticipé. */
  onTurn?: (msg: Anthropic.Beta.Messages.BetaMessage, usage: Usage) => void | Promise<void>;
  signal?: AbortSignal;
};

export type AgentRunResult = {
  finalText: string;
  stopReason: Anthropic.Beta.Messages.BetaMessage["stop_reason"] | "budget_exceeded";
  usage: Usage;
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
};

export class BudgetExceededError extends Error {
  constructor(public readonly usage: Usage, public readonly budgetUsd: number) {
    super(`Budget dépassé: ${usage.usd.toFixed(3)} USD > ${budgetUsd} USD`);
  }
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const cfg = config();
  if (cfg.LLM_PROVIDER === "openai_compat") {
    const { runOpenAICompat } = await import("./llm/openaiCompat.js");
    return runOpenAICompat(opts);
  }
  const budget = opts.budgetUsd ?? cfg.MISSION_BUDGET_USD;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, iterations: 0 };

  const params = {
    model: opts.model,
    max_tokens: 64_000,
    // Fable/Opus 5 : thinking adaptatif par défaut. On ne passe PAS budget_tokens (400).
    output_config: { effort: opts.effort ?? "high" },
    // Compaction serveur : le contexte est résumé automatiquement près du seuil.
    context_management: { edits: [{ type: "compact_20260112" as const }] },
    // Fallback serveur sur refus de sécurité : routage par catégorie, sans liste à maintenir.
    fallbacks: "default" as const,
    betas: ["compact-2026-01-12", "server-side-fallback-2026-07-01"],
    // Préfixe stable → cache. Tout ce qui varie (date, tâche) va dans `messages`.
    system: [{ type: "text" as const, text: opts.system, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }],
    messages: [{ role: "user" as const, content: opts.task }],
    tools: opts.tools,
    max_iterations: opts.maxIterations ?? 60,
    stream: true as const,
  };

  const runner = client().beta.messages.toolRunner(params, { signal: opts.signal ?? null });

  let last: Anthropic.Beta.Messages.BetaMessage | undefined;
  let stop: AgentRunResult["stopReason"] = "end_turn";

  try {
    for await (const stream of runner) {
      const message = await stream.finalMessage();
      last = message;
      usage.iterations += 1;
      usage.inputTokens += message.usage.input_tokens;
      usage.outputTokens += message.usage.output_tokens;
      usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
      usage.usd += priceOf(message.model, message.usage);

      logger.debug(
        { model: message.model, stop: message.stop_reason, iter: usage.iterations, usd: usage.usd.toFixed(4), cacheRead: message.usage.cache_read_input_tokens },
        "turn",
      );
      await opts.onTurn?.(message, usage);

      if (message.stop_reason === "refusal") {
        // Toute la chaîne (modèle + fallback) a refusé : on n'exécute pas les outils de ce tour.
        logger.warn({ details: message.stop_details }, "refus de sécurité");
        stop = "refusal";
        break;
      }
      if (message.stop_reason === "max_tokens") {
        // Une entrée d'outil tronquée échoue à la validation Zod → le modèle reçoit
        // un tool_result en erreur et recommence ; on relève le plafond pour la suite.
        logger.warn("max_tokens atteint : entrée d'outil potentiellement tronquée");
        runner.setMessagesParams((p) => ({ ...p, max_tokens: 128_000 }));
      }
      if (message.stop_reason === "pause_turn") {
        // Outil serveur (web_search / web_fetch) en pause : on renvoie le tour pour continuer.
        runner.pushMessages({ role: "assistant", content: message.content });
      }
      if (usage.usd > budget) {
        stop = "budget_exceeded";
        throw new BudgetExceededError(usage, budget);
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return { finalText: textOf(last), stopReason: "budget_exceeded", usage, messages: runner.params.messages };
    }
    if (err instanceof Anthropic.RateLimitError) {
      logger.error({ err }, "rate limit persistant après retries");
    }
    throw err;
  }

  return {
    finalText: textOf(last),
    stopReason: stop === "end_turn" ? (last?.stop_reason ?? "end_turn") : stop,
    usage,
    messages: runner.params.messages,
  };
}

export function textOf(msg: Anthropic.Beta.Messages.BetaMessage | undefined): string {
  if (!msg) return "";
  return msg.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Appel unique structuré (pas d'outils) : utilisé pour le rapport du matin
 * et les vérifications « juge ». Sortie JSON garantie par output_config.format.
 */
export async function structured<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: { type: "json_schema"; schema: Record<string, unknown> };
  effort?: Effort;
}): Promise<{ value: T; usd: number }> {
  if (config().LLM_PROVIDER === "openai_compat") {
    const { structuredOpenAICompat } = await import("./llm/openaiCompat.js");
    return structuredOpenAICompat<T>({ model: opts.model, system: opts.system, prompt: opts.prompt, schema: opts.schema.schema });
  }
  const res = await client().beta.messages.create({
    model: opts.model,
    max_tokens: 16_000,
    output_config: { effort: opts.effort ?? "medium", format: opts.schema },
    fallbacks: "default",
    betas: ["server-side-fallback-2026-07-01"],
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error(`refus: ${res.stop_details?.explanation ?? "?"}`);
  const text = textOf(res);
  return { value: JSON.parse(text) as T, usd: priceOf(res.model, res.usage) };
}
