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
  /**
   * Fournisseur des missions CRITIQUES (celles qui écrivent du code et déploient).
   * Mode éco : LLM_PROVIDER=openai_compat (DeepSeek) + LLM_PROVIDER_CRITICAL=anthropic.
   */
  LLM_PROVIDER_CRITICAL: z.enum(["anthropic", "openai_compat"]).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_COMPAT_BASE_URL: z.string().url().optional(),
  OPENAI_COMPAT_API_KEY: z.string().optional(),
  MODEL_PLANNER: z.string().default("claude-opus-5"),
  MODEL_CODER: z.string().default("claude-opus-5"),
  MODEL_WORKER: z.string().default("claude-sonnet-5"),
  /** Modèle des missions critiques (écriture + déploiement). Mode éco : claude-sonnet-5. */
  MODEL_CRITICAL: z.string().optional(),
  /** Modèle du chat WhatsApp (réponses courtes, fréquentes). Mode éco : deepseek-chat. */
  MODEL_CHAT: z.string().optional(),
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

  // --- Autonomie ---------------------------------------------------------------
  /**
   * manual    : RIEN ne tourne sans ordre (WhatsApp/Jarvis/API). Les crons par défaut sont
   *             ignorées ; seul le planning ordonné (table `schedules`) s'exécute. (défaut)
   * scheduled : les crons par défaut des missions tournent + le planning ordonné.
   */
  AUTONOMY_MODE: z.enum(["manual", "scheduled"]).default("manual"),

  /** Délai d'attente d'une approbation WhatsApp pour un outil irréversible. */
  APPROVAL_TIMEOUT_MIN: z.coerce.number().int().min(1).max(120).default(10),
  /** Messages entrants max par numéro et par heure. */
  CHAT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(60),
  /** Timeout mural d'une mission (minutes) : au-delà, arrêt propre et épisode marqué failed. */
  MISSION_TIMEOUT_MIN: z.coerce.number().int().min(5).max(240).default(45),
  /** Heartbeat : vérifie DB + sandbox toutes les heures et t'alerte UNE fois en cas de panne (pas une mission : un état de santé). */
  HEARTBEAT_ALERTS: z.coerce.boolean().default(true),
  /** Vérification indépendante des livrables de mission par un « juge » (appel structuré, ~0,01 $). */
  VERIFY_MISSIONS: z.coerce.boolean().default(true),
  /** Domaines interdits au navigateur (suffixes, séparés par des virgules), ex: "ma-banque.fr,paypal.com". */
  BROWSER_DENY_DOMAINS: z.string().default(""),

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
  /**
   * Navigateur : URL CDP de TON Chrome (via tunnel SSH inverse + host.docker.internal),
   * ex: http://host.docker.internal:9222. Vide = Chromium persistant dans le sandbox.
   */
  BROWSER_CDP_URL: z.string().url().optional(),

  // --- GitHub / Vercel -----------------------------------------------------
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "format owner/repo"),
  GIT_AUTHOR_NAME: z.string().default("Manzi Junior"),
  GIT_AUTHOR_EMAIL: z.string().email().default("bot@example.com"),
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_PROJECT: z.string().optional(),
  SITE_URL: z.string().url().optional(),

  // --- X (Twitter) : scraping direct des profils publics (gratuit, best-effort) --
  /** Cookie auth_token d'un compte X secondaire, optionnel : améliore le taux de réussite. Risque : suspension de ce compte. */
  X_AUTH_TOKEN: z.string().optional(),

  // --- Rapport du matin / alertes ----------------------------------------------
  REPORT_TO_EMAIL: z.string().email().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // --- WhatsApp (canal principal) ----------------------------------------------
  WHATSAPP_PROVIDER: z.enum(["none", "meta", "twilio"]).default("none"),
  /** Numéros autorisés à commander le bot (E.164 sans +, ex: 33612345678), séparés par des virgules. */
  WHATSAPP_ALLOWED_NUMBERS: z.string().default(""),
  // Meta Cloud API
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  /** Nom du modèle de message approuvé pour les envois hors fenêtre 24 h (rapport du matin). */
  WHATSAPP_TEMPLATE_NAME: z.string().default("manzi_daily_report"),
  WHATSAPP_TEMPLATE_LANG: z.string().default("fr"),

  // --- Transcription des messages vocaux ---------------------------------------
  /**
   * N'importe quelle API compatible OpenAI `/audio/transcriptions` (OpenAI,
   * Groq, serveur Whisper local). Vide = les vocaux sont signalés mais pas
   * transcrits. Whisper dans le conteneur demanderait plus de RAM qu'il n'en
   * reste sur un 4 Go déjà partagé avec Chromium.
   */
  TRANSCRIBE_BASE_URL: z.string().url().optional(),
  TRANSCRIBE_API_KEY: z.string().optional(),
  TRANSCRIBE_MODEL: z.string().default("whisper-large-v3"),
  /** Langue attendue des vocaux (code ISO). Améliore nettement la transcription. */
  JARVIS_LANGUAGE: z.string().default("fr"),

  // --- Google (Gmail + Agenda) --------------------------------------------------
  /**
   * Le jeton de rafraîchissement s'obtient une fois depuis un poste avec
   * navigateur (deploy/google-auth.ps1) ; il ne dépend ensuite ni de l'adresse
   * IP, ni du poste, ni d'une session ouverte — contrairement aux cookies d'un
   * navigateur, qu'un changement de pays suffit à faire invalider par Google.
   */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  /** Jeton de la balise Search Console : prouve la propriété du domaine sans toucher au DNS. */
  GOOGLE_SITE_VERIFICATION: z.string().optional(),
  // Twilio
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  /** URL publique du webhook (Cloudflare Tunnel ou domaine), nécessaire pour vérifier les signatures Twilio. */
  PUBLIC_URL: z.string().url().optional(),

  // --- MCP -----------------------------------------------------------------
  MCP_CONFIG_PATH: z.string().default("./mcp.json"),

  // --- Santé ---------------------------------------------------------------
  HEALTH_PORT: z.coerce.number().int().default(8787),
});

export type Config = z.infer<typeof Env>;

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  // `KEY=` dans un .env donne "" et non `undefined` : sans ce filtre, toute
  // variable facultative laissée vide échoue à sa validation de format
  // (e-mail, URL) et empêche le démarrage, alors qu'elle est justement
  // facultative. Une variable vide vaut « non renseignée ».
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // « PUBLIC_URL: Invalid URL » ne dit pas ce que PUBLIC_URL contient, et
    // l'orchestrateur redémarre en boucle sur ce message. La valeur reçue est
    // presque toujours la réponse — un gabarit recopié tel quel, un espace,
    // un guillemet. On l'affiche donc, SAUF pour les variables qui portent un
    // secret : un journal de démarrage est lu, copié et collé bien plus
    // souvent qu'un .env.
    // DATABASE_URL ne contient aucun de ces mots et porte pourtant le mot de
    // passe Postgres : le nom d'une variable ne dit pas toujours ce qu'elle
    // cache. On la nomme, et on retire en plus tout `user:motdepasse@` d'une
    // valeur affichée, pour les DSN qu'on n'aurait pas prévus.
    const secret = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|DSN/i;
    const issues = parsed.error.issues
      .map((i) => {
        const name = i.path.join(".");
        const got = env[name as keyof typeof env];
        if (secret.test(name) || typeof got !== "string") return `  - ${name}: ${i.message}`;
        const shown = got.replace(/\/\/[^/@\s]*:[^/@\s]*@/g, "//***:***@").slice(0, 120);
        return `  - ${name}: ${i.message} (reçu : « ${shown} »)`;
      })
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
