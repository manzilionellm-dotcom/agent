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
 * Dix rôles. Chacun a : un modèle, un niveau d'effort, un budget, ses outils,
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
  | "analyst";

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
};

export function roleTools(role: Role, container?: string) {
  return [...role.tools(container), ...mcpToolsFor(role.mcpServers, { allowIrreversible: role.allowIrreversible })];
}
