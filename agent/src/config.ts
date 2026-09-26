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

  LLM_PROVIDER: z.enum(["anthropic", "openai_compat"]).default("anthropic"),
  LLM_PROVIDER_CRITICAL: z.enum(["anthropic", "openai_compat"]).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_COMPAT_BASE_URL: z.string().url().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  MODEL_PLANNER: z.string().default("claude-opus-5"),
  MODEL_CODER: z.string().default("claude-opus-5"),
  MODEL_WORKER: z.string().default("claude-sonnet-5"),
  MODEL_CRITICAL: z.string().optional(),
  MODEL_CHAT: z.string().optional(),
  MODEL_PRICES: z.string().default(""),

  TAVILY_API_KEY: z.string().optional(),
  SERPAPI_API_KEY: z.string().optional(),

  SANDBOX_POOL: z.string().default(""),
  SWARM_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(10),
  SWARM_BUDGET_USD: z.coerce.number().positive().default(15),

  AUTONOMY_MODE: z.enum(["manual", "scheduled"]).default("manual"),

  APPROVAL_TIMEOUT_MIN: z.coerce.number().int().min(1).max(120).default(10),
  CHAT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(60),
  MISSION_TIMEOUT_MIN: z.coerce.number().int().min(5).max(240).default(45),
  HEARTBEAT_ALERTS: z.coerce.boolean().default(true),
  VERIFY_MISSIONS: z.coerce.boolean().default(true),
  BROWSER_DENY_DOMAINS: z.string().default(""),

  ORCHESTRATOR_TOKEN: z.string().optional(),
  MISSION_BUDGET_USD: z.coerce.number().positive().default(3),
  DAILY_BUDGET_USD: z.coerce.number().positive().default(25),

  DATABASE_URL: z.string().url(),

  SANDBOX_CONTAINER: z.string().default("manzi-sandbox"),
  SANDBOX_WORKDIR: z.string().default("/work"),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),
  /**
   * Navigateur : URL CDP de TON Chrome (via tunnel SSH inverse + host.docker.internal),
   * ex: http://host.docker.internal:9222. Vide = Chromium persistant dans le sandbox.
   * Préférer CDP (Chrome réel) ; sinon stealth sandbox (BROWSER_STEALTH). Voir docs/STEALTH.md.
   */
  BROWSER_CDP_URL: z.string().url().optional(),
  /**
   * Stealth Chromium sandbox (défaut true). Ignoré si BROWSER_CDP_URL (Chrome réel déjà « humain »).
   */
  BROWSER_STEALTH: z.coerce.boolean().default(true),
  /** Locale Playwright du contexte (sv-SE défaut pour Europe/Stockholm ; fr-FR, fr-CA, en-CA…). */
  BROWSER_LOCALE: z.string().default("sv-SE"),
  /** Fuseau IANA du contexte navigateur. */
  BROWSER_TIMEZONE: z.string().default("Europe/Stockholm"),

  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "format owner/repo"),
  GIT_AUTHOR_NAME: z.string().default("Manzi Junior"),
  GIT_AUTHOR_EMAIL: z.string().email().default("bot@example.com"),
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_PROJECT: z.string().optional(),
  SITE_URL: z.string().url().optional(),

  X_AUTH_TOKEN: z.string().optional(),

  REPORT_TO_EMAIL: z.string().email().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  WHATSAPP_PROVIDER: z.enum(["none", "meta", "twilio"]).default("none"),
  WHATSAPP_ALLOWED_NUMBERS: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_TEMPLATE_NAME: z.string().default("manzi_daily_report"),
  WHATSAPP_TEMPLATE_LANG: z.string().default("fr"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  PUBLIC_URL: z.string().url().optional(),

  MCP_CONFIG_PATH: z.string().default("./mcp.json"),

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
  const critical = c.LLM_PROVIDER_CRITICAL ?? c.LLM_PROVIDER;
  if ((c.LLM_PROVIDER === "anthropic" || critical === "anthropic") && !c.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY requis (fournisseur anthropic pour les missions normales ou critiques)");
  if (c.WHATSAPP_PROVIDER === "meta" && !(c.WHATSAPP_PHONE_NUMBER_ID && c.WHATSAPP_ACCESS_TOKEN && c.WHATSAPP_APP_SECRET && c.WHATSAPP_VERIFY_TOKEN))
    throw new Error("WHATSAPP_PROVIDER=meta exige WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN");
  if (c.WHATSAPP_PROVIDER === "twilio" && !(c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && c.TWILIO_WHATSAPP_FROM))
    throw new Error("WHATSAPP_PROVIDER=twilio exige TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM");
  if (c.WHATSAPP_PROVIDER !== "none" && !c.WHATSAPP_ALLOWED_NUMBERS) throw new Error("WHATSAPP_ALLOWED_NUMBERS requis : sinon n'importe qui peut commander le bot");
  if (c.LLM_PROVIDER === "openai_compat" && (!c.OPENAI_COMPAT_BASE_URL || !c.OPENAI_COMPAT_API_KEY))
    throw new Error("OPENAI_COMPAT_BASE_URL et OPENAI_COMPAT_API_KEY requis avec LLM_PROVIDER=openai_compat");
  if (c.LLM_PROVIDER === "openai_compat" && !c.TAVILY_API_KEY && !c.SERPAPI_API_KEY)
    throw new Error("Sans Claude, la recherche web passe par Tavily ou SerpAPI : définir TAVILY_API_KEY ou SERPAPI_API_KEY");
  cached = c;
  return cached;
}
