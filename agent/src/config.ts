import { z } from "zod";

/**
 * Toute la configuration passe par des variables d'environnement validées.
 * Une variable manquante fait échouer le boot (fail-fast) plutôt qu'une
 * mission à 3h du matin.
 */
const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  TZ: z.string().default("Europe/Paris"),

  // --- LLM -----------------------------------------------------------------
  /**
   * anthropic      : Claude via SDK officiel (défaut — outils serveur web_search/web_fetch,
   *                  compaction, fallback, cache 1h, meilleure fiabilité agentique mesurée).
   * openai_compat  : tout endpoint compatible OpenAI (DeepSeek, Moonshot/Kimi, Qwen via
   *                  DashScope, OpenRouter, vLLM local). Perd les outils serveur → Tavily obligatoire.
   */
  LLM_PROVIDER: z.enum(["anthropic", "openai_compat"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_COMPAT_BASE_URL: z.string().url().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  MODEL_PLANNER: z.string().default("claude-opus-5"),
  MODEL_CODER: z.string().default("claude-opus-5"),
  MODEL_WORKER: z.string().default("claude-sonnet-5"),
  /** Prix custom pour un modèle non Anthropic : "deepseek-chat=0.27/1.1,kimi-k2=0.6/2.5" (USD in/out par 1M). */
  MODEL_PRICES: z.string().default(""),

  // --- Recherche temps réel (client tools, marchent avec tous les fournisseurs) ----
  TAVILY_API_KEY: z.string().optional(),
  SERPAPI_API_KEY: z.string().optional(),

  // --- Essaim ----------------------------------------------------------------
  /** Conteneurs sandbox disponibles, séparés par des virgules. 1 sous-agent code = 1 conteneur. */
  SANDBOX_POOL: z.string().default(""),
  SWARM_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(10),
  SWARM_BUDGET_USD: z.coerce.number().positive().default(15),

  // --- API HTTP locale (Jarvis, curl) --------------------------------------
  ORCHESTRATOR_TOKEN: z.string().optional(),
  /** Plafond de dépense par mission, en USD. Coupe la boucle au-delà. */
  MISSION_BUDGET_USD: z.coerce.number().positive().default(3),
  /** Plafond journalier global, en USD. Le scheduler refuse de lancer au-delà. */
  DAILY_BUDGET_USD: z.coerce.number().positive().default(25),

  // --- Mémoire -------------------------------------------------------------
  DATABASE_URL: z.string().url(),

  // --- Sandbox -------------------------------------------------------------
  /** Nom du conteneur sandbox (docker compose service `sandbox`). */
  SANDBOX_CONTAINER: z.string().default("manzi-sandbox"),
  /** Répertoire de travail dans le sandbox où les dépôts sont clonés. */
  SANDBOX_WORKDIR: z.string().default("/work"),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),

  // --- GitHub / Vercel -----------------------------------------------------
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "format owner/repo"),
  GIT_AUTHOR_NAME: z.string().default("Manzi Junior"),
  GIT_AUTHOR_EMAIL: z.string().email().default("bot@example.com"),
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_PROJECT: z.string().optional(),
  SITE_URL: z.string().url().optional(),

  // --- X (Twitter) API v2 : uniquement l'API officielle -------------------
  X_BEARER_TOKEN: z.string().optional(),

  // --- Rapport du matin ----------------------------------------------------
  REPORT_TO_EMAIL: z.string().email().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // --- MCP -----------------------------------------------------------------
  MCP_CONFIG_PATH: z.string().default("./mcp.json"),

  // --- Santé ---------------------------------------------------------------
  HEALTH_PORT: z.coerce.number().int().default(8787),
});

export type Config = z.infer<typeof Env>;

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuration invalide:\n${issues}`);
  }
  const c = parsed.data;
  if (c.LLM_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY requis avec LLM_PROVIDER=anthropic");
  if (c.LLM_PROVIDER === "openai_compat" && (!c.OPENAI_COMPAT_BASE_URL || !c.OPENAI_COMPAT_API_KEY))
    throw new Error("OPENAI_COMPAT_BASE_URL et OPENAI_COMPAT_API_KEY requis avec LLM_PROVIDER=openai_compat");
  if (c.LLM_PROVIDER === "openai_compat" && !c.TAVILY_API_KEY && !c.SERPAPI_API_KEY)
    throw new Error("Sans Claude, la recherche web passe par Tavily ou SerpAPI : définir TAVILY_API_KEY ou SERPAPI_API_KEY");
  cached = c;
  return cached;
}
