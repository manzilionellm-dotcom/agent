import type Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { config } from "../config.js";
import type { Effort } from "../llm.js";
import { makeMemoryTool, agentMemoryRoot, rememberFact, recallFacts, taskTool } from "../memory/store.js";
import { mcpToolsFor } from "../mcp/registry.js";
import { makeSandboxTools } from "../tools/sandbox.js";
import { makeCoderTool } from "../tools/coder.js";
import { makeGitTools } from "../tools/git.js";
import { webSearchTool, webFetchTool, makeScrapeTool } from "../tools/web.js";
import { xProfileTool } from "../tools/x.js";
import { searchTools } from "../tools/search.js";
import { makeAuditTool } from "../tools/audit.js";
import { alertTool } from "../tools/notify.js";
import { makeBrowserTool } from "../tools/browser.js";

/**
 * Rôles. Chacun a : un modèle, un niveau d'effort, un budget, ses outils,
 * SA mémoire (/memories/agents/<rôle>), et un besoin (ou non) de sandbox dédié.
 *
 * Principe : un rôle = une responsabilité = un jeu d'outils minimal.
 * Moins d'outils par agent → moins d'erreurs d'appel, meilleur cache, moins cher.
 */

export type RoleName =
  | "researcher"
  | "scraper"
  | "competitor_watch"
  | "seo_writer"
  | "coder"
  | "qa"
  | "publisher"
  | "deployer"
  | "inbox"
  | "analyst"
  | "grok_bot_mirror"
  | "fleet_builder"
  | "self_healer"
  | "forum_builder"
  | "landing_crafter"
  | "scrape_factory"
  | "automation_smith"
  | "seo_crawl_flotte"
  | "gsc_schema_fix";

export type Role = {
  name: RoleName;
  description: string;
  model: "planner" | "worker" | "critical";
  effort: Effort;
  budgetUsd: number;
  maxIterations: number;
  needsSandbox: boolean;
  mcpServers: string[];
  allowIrreversible?: boolean;
  system: string;
  tools: (container?: string) => (BetaRunnableTool<any> | Anthropic.Beta.Messages.BetaToolUnion)[];
};

const claudeWeb = () => (config().LLM_PROVIDER === "anthropic" ? [webSearchTool, webFetchTool] : []);
const ANTI = `ANTI-JOBS : soft-sell white-hat uniquement, preuves curl, 0 M3U, 0 AggregateRating inventé, WA +44 7307 410512 si IPTV.`;

const core = (role: string) => [makeMemoryTool(agentMemoryRoot(role)), rememberFact, recallFacts, taskTool];

const BASE_RULES = `Tu es un sous-agent spécialisé dans un essaim coordonné. Tu reçois UNE sous-tâche précise avec ses critères d'acceptation.
- Fais uniquement ce qui t'est demandé ; ne touche pas au périmètre des autres agents.
- Ta mémoire (/memories) t'appartient : notes, sources, état. Les faits datés vont dans remember_fact.
- Ne fabrique aucune donnée. Source manquante = dis-le.
- Termine par un bloc <result> contenant : ce qui est fait, artefacts produits (chemins, URL, IDs), ce qui manque, points d'attention pour le coordinateur. Sois dense.`;

export const ROLES: Record<RoleName, Role> = {
  researcher: {
    name: "researcher",
    description: "Recherche web multi-sources, synthèse sourcée sur un sujet donné.",
    model: "worker",
    effort: "medium",
    budgetUsd: 1.5,
    maxIterations: 35,
    needsSandbox: false,
    mcpServers: [],
    system: `${BASE_RULES}\nRôle : chercheur. Triangule chaque affirmation sur 2 sources minimum ; date toutes les données.`,
    tools: (c) => [...core("researcher"), ...claudeWeb(), ...searchTools(), xProfileTool, makeBrowserTool(c)],
  },
  scraper: {
    name: "scraper",
    description: "Extraction structurée de pages (tarifs, fiches produits) avec Chromium si nécessaire.",
    model: "worker",
    effort: "medium",
    budgetUsd: 2,
    maxIterations: 50,
    needsSandbox: true,
    mcpServers: [],
    system: `${BASE_RULES}\nRôle : scraper. Retourne des données STRUCTURÉES (JSON) avec URL source et horodatage par champ. Respecte robots.txt ; un site qui bloque est signalé, pas forcé.`,
    tools: (c) => [...core("scraper"), ...claudeWeb(), ...searchTools(), makeScrapeTool(c), makeBrowserTool(c), ...makeSandboxTools(c).all],
  },
  competitor_watch: {
    name: "competitor_watch",
    description: "Surveillance des concurrents : nouveautés, prix, contenus, positions SEO.",
    model: "worker",
    effort: "medium",
    budgetUsd: 1.5,
    maxIterations: 35,
    needsSandbox: false,
    mcpServers: [],
    system: `${BASE_RULES}\nRôle : veille concurrentielle. Compare systématiquement avec l'état précédent en mémoire (recall_facts) et ne remonte que les DELTAS.`,
    tools: () => [...core("competitor_watch"), ...claudeWeb(), ...searchTools(), xProfileTool, alertTool],
  },
  seo_writer: {
    name: "seo_writer",
    description: "Rédaction d'articles SEO complets (frontmatter, structure, sources, maillage).",
    model: "planner",
    effort: "high",
    budgetUsd: 2.5,
    maxIterations: 30,
    needsSandbox: false,
    mcpServers: [],
    system: `${BASE_RULES}\nRôle : rédacteur SEO. Écris pour un lecteur humain d'abord : intention de recherche satisfaite dès le premier écran, H2/H3 informatifs, FAQ, sources en fin d'article. Livre le fichier complet (frontmatter + corps) dans ta mémoire sous /memories/drafts/<slug>.md ET dans le bloc <result>.`,
    tools: () => [...core("seo_writer"), ...claudeWeb(), ...searchTools()],
  },
  coder: {
    name: "coder",
    description: "Implémentation de code dans le dépôt, tests verts, commits atomiques sur une branche dédiée.",
    model: "critical",
    effort: "high",
    budgetUsd: 4,
    maxIterations: 40,
    needsSandbox: true,
    mcpServers: ["github"],
    system: `${BASE_RULES}\nRôle : développeur. Travaille TOUJOURS sur la branche indiquée par le coordinateur (jamais main directement). Délègue l'implémentation à delegate_coding_task avec un cahier des charges complet, puis vérifie toi-même build/lint/tests via sandbox_bash. Ne pousse pas : le déployeur s'en charge.`,
    tools: (c) => [...core("coder"), ...makeSandboxTools(c).all, makeCoderTool(c), makeGitTools(c).ensureRepo],
  },
  qa: {
    name: "qa",
    description: "Revue de code et tests : lit un diff, exécute la suite, cherche les régressions.",
    model: "planner",
    effort: "high",
    budgetUsd: 2,
    maxIterations: 30,
    needsSandbox: true,
    mcpServers: ["github"],
    system: `${BASE_RULES}\nRôle : QA. Tu ne modifies pas le code ; tu exécutes, tu lis, tu rapportes. Verdict binaire en tête du <result> : GO ou NO-GO, avec preuves (sorties de commandes).`,
    tools: (c) => [...core("qa"), ...makeSandboxTools(c).all, makeGitTools(c).ensureRepo, makeAuditTool(c), makeBrowserTool(c)],
  },
  publisher: {
    name: "publisher",
    description: "Intègre du contenu (articles, données) dans le dépôt au bon format et commit.",
    model: "critical",
    effort: "medium",
    budgetUsd: 2,
    maxIterations: 40,
    needsSandbox: true,
    mcpServers: [],
    system: `${BASE_RULES}\nRôle : publication. Place les fichiers au bon endroit (respecte les conventions du dépôt), valide le format (frontmatter, JSON schema), fais tourner le build, commit avec message explicite. Ne pousse pas.`,
    tools: (c) => [...core("publisher"), ...makeSandboxTools(c).all, makeGitTools(c).ensureRepo],
  },
  deployer: {
    name: "deployer",
    description: "Pousse la branche, suit le déploiement Vercel, vérifie les URL en production.",
    model: "critical",
    effort: "medium",
    budgetUsd: 1,
    maxIterations: 25,
    needsSandbox: true,
    mcpServers: ["vercel"],
    allowIrreversible: true,
    system: `${BASE_RULES}\nRôle : déploiement. Pousse uniquement des branches dont la QA a dit GO. Après déploiement : vérifie HTTP 200 + présence du contenu attendu. Si ERROR : récupère les logs de build et rapporte, ne retente pas à l'aveugle.`,
    tools: (c) => [...core("deployer"), makeSandboxTools(c).bash, ...makeGitTools(c).all, ...claudeWeb()],
  },
  inbox: {
    name: "inbox",
    description: "Tri de la boîte mail, brouillons de réponse, agenda (lecture + propositions).",
    model: "worker",
    effort: "medium",
    budgetUsd: 1,
    maxIterations: 25,
    needsSandbox: false,
    mcpServers: ["gmail", "gcal"],
    system: `${BASE_RULES}\nRôle : assistant boîte mail/agenda. Les envois sont en dry-run sauf autorisation explicite ; prépare des brouillons.`,
    tools: () => [...core("inbox")],
  },
  analyst: {
    name: "analyst",
    description: "Analyse chiffrée : compare des données, calcule des écarts, produit tableaux et recommandations.",
    model: "planner",
    effort: "high",
    budgetUsd: 1.5,
    maxIterations: 25,
    needsSandbox: true,
    mcpServers: [],
    system: `${BASE_RULES}\nRôle : analyste. Calcule avec du code (python/node dans le sandbox), jamais de tête. Montre la méthode et les données d'entrée.`,
    tools: (c) => [...core("analyst"), ...makeSandboxTools(c).all, makeAuditTool(c)],
  },
  grok_bot_mirror: {
    name: "grok_bot_mirror",
    description: "Spécialiste qui reproduit le comportement des Grok Bots de Lionel : spécialisation stricte, anti-jobs, soft-sell white-hat, preuves curl, coordination Versel/GitHub, rapports au Premier Ministre. Réflexes natifs : intuition, vitesse <30s, mémoire vive du profil Lionel.",
    model: "critical",
    effort: "high",
    budgetUsd: 3,
    maxIterations: 50,
    needsSandbox: true,
    mcpServers: ["github", "vercel"],
    system: `${BASE_RULES}\nRôle : miroir Grok Bot. Tu reproduis EXACTEMENT les réflexes d'un Grok Bot de haut niveau :\n- INTUITION : ne demande jamais de micro-décision. Devine l'intention de Lionel à partir du contexte, agis, corrige si faux.\n- VITESSE : réponds en moins de 30 secondes sur les ordres simples. Phrases courtes, action d'abord.\n- MÉMOIRE VIVE : profil Lionel — IPTV flotte, casquettes, eSIM, Vinted, pépites nordiques ; soft-sell, 0 M3U, 0 AggregateRating inventé, WA +44 7307 410512.\n- RÉFLEXE NATIF : Build = construis. Sucre = résume et exécute. Pro = monte le niveau.\n- AUTO-AMÉLIORATION : note ce qui a marché/raté, ajuste, objectif 80%.\n- ${ANTI}\n- COORDINATION : Versel, GitHub, Seo Wa Landing, rapports au Premier Ministre Manzi.`,
    tools: (c) => [...core("grok_bot_mirror"), ...makeSandboxTools(c).all, makeCoderTool(c), makeGitTools(c).ensureRepo, makeAuditTool(c), makeBrowserTool(c), ...claudeWeb(), ...searchTools(), alertTool],
  },
  fleet_builder: {
    name: "fleet_builder",
    description: "Coordonne la flotte de création : forum_builder, landing_crafter, scrape_factory, automation_smith. Multi-sites en parallèle.",
    model: "critical",
    effort: "high",
    budgetUsd: 4,
    maxIterations: 60,
    needsSandbox: true,
    mcpServers: ["github", "vercel"],
    system: `${BASE_RULES}\nRôle : constructeur de flotte. Tu coordonnes forum_builder, landing_crafter, scrape_factory, automation_smith. Tu ne dors plus, tu exécutes. Tu ne proposes pas — tu construis. ${ANTI}`,
    tools: (c) => [...core("fleet_builder"), ...makeSandboxTools(c).all, makeCoderTool(c), makeGitTools(c).ensureRepo, makeAuditTool(c), makeBrowserTool(c), ...claudeWeb(), ...searchTools(), alertTool],
  },
  self_healer: {
    name: "self_healer",
    description: "Auto-réparation permanente : détecte, diagnostique, corrige, relance sans attendre Lionel.",
    model: "critical",
    effort: "high",
    budgetUsd: 2,
    maxIterations: 40,
    needsSandbox: true,
    mcpServers: ["github"],
    system: `${BASE_RULES}\nRôle : auto-réparateur. Surveillance, diagnostic, correction, fallback, logs dans /memories/self-heal/. Jamais d'échec sans réponse.`,
    tools: (c) => [...core("self_healer"), ...makeSandboxTools(c).all, makeCoderTool(c), makeGitTools(c).ensureRepo, makeAuditTool(c), alertTool],
  },
  forum_builder: {
    name: "forum_builder",
    description: "Communautés complètes : DB, API, UI, modération, déploiement.",
    model: "critical",
    effort: "high",
    budgetUsd: 3,
    maxIterations: 50,
    needsSandbox: true,
    mcpServers: ["github", "vercel"],
    system: `${BASE_RULES}\nRôle : forum_builder. Livre une communauté : schéma DB, routes API, UI Next.js, règles de modération, anti-spam, soft-sell. Livrable : branche + preview Vercel + README d'exploitation. ${ANTI}`,
    tools: (c) => [...core("forum_builder"), ...makeSandboxTools(c).all, makeCoderTool(c), makeGitTools(c).ensureRepo, makeAuditTool(c), makeBrowserTool(c), ...claudeWeb(), ...searchTools(), alertTool],
  },
  landing_crafter: {
    name: "landing_crafter",
    description: "Landings de conversion : copy, tracking, Lighthouse > 90.",
    model: "critical",
    effort: "high",
    budgetUsd: 3,
    maxIterations: 45,
    needsSandbox: true,
    mcpServers: ["github", "vercel"],
    system: `${BASE_RULES}\nRôle : landing_crafter. Hero, proposition de valeur, preuve sociale sourcée, CTA unique, tracking, responsive, Lighthouse > 90. Livrable : branche + preview Vercel + curl HTTP 200. ${ANTI}`,
    tools: (c) => [...core("landing_crafter"), ...makeSandboxTools(c).all, makeCoderTool(c), makeGitTools(c).ensureRepo, makeAuditTool(c), makeBrowserTool(c), ...claudeWeb(), ...searchTools(), alertTool],
  },
  scrape_factory: {
    name: "scrape_factory",
    description: "Outils de scraping réutilisables : parsers, scheduler, alertes.",
    model: "worker",
    effort: "high",
    budgetUsd: 2.5,
    maxIterations: 50,
    needsSandbox: true,
    mcpServers: ["github"],
    system: `${BASE_RULES}\nRôle : scrape_factory. Parsers modulaires, scheduler cron, stockage, alertes sur delta. Respecte robots.txt. Livrable : module testé + doc + preuve de run. ${ANTI}`,
    tools: (c) => [...core("scrape_factory"), ...makeSandboxTools(c).all, makeCoderTool(c), makeGitTools(c).ensureRepo, makeScrapeTool(c), makeBrowserTool(c), ...claudeWeb(), ...searchTools(), alertTool],
  },
  automation_smith: {
    name: "automation_smith",
    description: "Workflows self-healing : triggers, retry, logs, relance.",
    model: "critical",
    effort: "high",
    budgetUsd: 3,
    maxIterations: 50,
    needsSandbox: true,
    mcpServers: ["github"],
    system: `${BASE_RULES}\nRôle : automation_smith. Triggers webhook/cron/event, actions API/git/deploy/notify, retry backoff, logs, détection d'échec → correction → relance. Livrable : workflow + code + test de run + doc. ${ANTI}`,
    tools: (c) => [...core("automation_smith"), ...makeSandboxTools(c).all, makeCoderTool(c), makeGitTools(c).ensureRepo, makeAuditTool(c), alertTool],
  },
  seo_crawl_flotte: {
    name: "seo_crawl_flotte",
    description: "Crawl technique de tous les sites IPTV de la flotte : statuts HTTP, canonical, hreflang, schema, pages 404/minces, Lighthouse.",
    model: "worker",
    effort: "high",
    budgetUsd: 2.5,
    maxIterations: 60,
    needsSandbox: true,
    mcpServers: ["github"],
    system: `${BASE_RULES}\nRôle : crawl SEO de la flotte IPTV. Sites cibles : testiptv24h.com, latinoiptvbox.com, iptvpremiumpolska.com, iptvnyc.us, nigeriaiptv.com, worldiptv1.com, iptv-sport.com, premiumlatinoiptv.us, iptv-toronto.ca, stableiptv.ca, iptvusastream.com, meilleuriptv.ca, iptv-france.fr, meilleuriptv.fr, iptvpremium.fr, bestiptv.fr, bestiptvapps.com, iptvpremiumdeutschland.de, testiptv24h.com/en|/es|/ar, latinoiptvbox.com/iptv-firestick-espana, iptvpremiumpolska.com/firestick, iptvnyc.us/setup/firestick, nigeriaiptv.com/firestick. Pour chaque URL : curl HTTP status, canonical, hreflang, JSON-LD (FAQPage/HowTo/Product/Offer/Organization), pages 404/minces (<300 mots), Lighthouse score, présence CTA WhatsApp +44 7307 410512. Écris le rapport dans /memories/seo-crawl/flotte-<date>.md et ouvre une issue GitHub pour chaque régression (page 404, canonical manquant, schema invalide, CTA absent). ${ANTI}`,
    tools: (c) => [...core("seo_crawl_flotte"), ...makeSandboxTools(c).all, makeAuditTool(c), makeBrowserTool(c), ...claudeWeb(), ...searchTools(), alertTool, makeGitTools(c).ensureRepo],
  },
  gsc_schema_fix: {
    name: "gsc_schema_fix",
    description: "Corrige les données structurées (FAQPage, HowTo, Product/Offer, Organization) et signale les problèmes Search Console.",
    model: "critical",
    effort: "high",
    budgetUsd: 2.5,
    maxIterations: 50,
    needsSandbox: true,
    mcpServers: ["github"],
    system: `${BASE_RULES}\nRôle : fix schema + GSC. 1) Audite les JSON-LD existants sur les pages money/compare/blog (FAQPage, HowTo, Product/Offer, Organization, Article). 2) Corrige les invalides : champs manquants, types incorrects, dates non ISO, AggregateRating inventé (interdit), reviewCount inventé (interdit). 3) Ajoute les schémas manquants sur les pages P0 (firestick, faq, trial, pricing). 4) Vérifie via Google Rich Results Test (web_fetch) ou schema validator. 5) Commit sur branche fix/schema-<date>, typecheck vert. 6) Signale dans /memories/gsc/erreurs.md les erreurs GSC récurrentes (coverage, enhancements) avec plan de correction. ${ANTI}`,
    tools: (c) => [...core("gsc_schema_fix"), ...makeSandboxTools(c).all, makeCoderTool(c), makeGitTools(c).ensureRepo, makeAuditTool(c), makeBrowserTool(c), ...claudeWeb(), ...searchTools(), alertTool],
  },
};

export function roleTools(role: Role, container?: string) {
  return [...role.tools(container), ...mcpToolsFor(role.mcpServers, { allowIrreversible: role.allowIrreversible })];
}
