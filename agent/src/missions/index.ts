import type Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { config } from "../config.js";
import { runAgent, type Effort, type Usage } from "../llm.js";
import { logger } from "../logger.js";
import { OPERATOR_SYSTEM } from "../prompts.js";
import { memoryTool, memoryDigest, rememberFact, recallFacts, taskTool, episodesTool, openEpisode, closeEpisode } from "../memory/store.js";
import { mcpToolsFor } from "../mcp/registry.js";
import { bashTool, readFileTool, writeFileTool } from "../tools/sandbox.js";
import { coderTool } from "../tools/coder.js";
import { ensureRepoTool, pushDeployTool } from "../tools/git.js";
import { webSearchTool, webFetchTool, scrapePageTool } from "../tools/web.js";
import { xSearchTool } from "../tools/x.js";
import { searchTools } from "../tools/search.js";
import { auditTool } from "../tools/audit.js";
import { alertTool } from "../tools/notify.js";

/**
 * Une mission = un cahier des charges + un jeu d'outils + un budget.
 * Le planificateur (Opus 5) reçoit TOUT d'un coup : mémoire, date, consignes.
 * Les missions « bulk » (veille, SEO) tournent sur Sonnet 5 : 2,5× moins cher,
 * largement suffisant quand le cadre est précis.
 */
export type Mission = {
  name: string;
  /** cron 5 champs, dans le fuseau TZ de la config. */
  cron: string;
  model: "planner" | "worker";
  effort: Effort;
  budgetUsd: number;
  maxIterations: number;
  mcpServers: string[];
  allowIrreversible?: boolean;
  tools: (BetaRunnableTool<any> | Anthropic.Beta.Messages.BetaToolUnion)[];
  task: (ctx: MissionContext) => string;
};

export type MissionContext = { now: Date; memory: string; siteUrl: string; repo: string };

const CORE_TOOLS = [memoryTool, rememberFact, recallFacts, taskTool];
const SANDBOX_TOOLS = [bashTool, readFileTool, writeFileTool];
const CLAUDE_WEB = () => (config().LLM_PROVIDER === "anthropic" ? [webSearchTool, webFetchTool] : []);
const WEB_TOOLS = [...CLAUDE_WEB(), ...searchTools(), scrapePageTool, xSearchTool];

export const MISSIONS: Mission[] = [
  {
    name: "veille",
    cron: "0 5 * * *",
    model: "worker",
    effort: "medium",
    budgetUsd: 1.5,
    maxIterations: 40,
    mcpServers: [],
    tools: [...CORE_TOOLS, ...WEB_TOOLS],
    task: ({ now }) => `Date: ${now.toISOString()}.
Mission VEILLE quotidienne (IPTV légal, streaming, SEO, concurrents du comparateur, actualité réglementaire ARCOM/UE).
1. Relis /memories/veille/sources.md (crée-le s'il n'existe pas avec 10 sources fiables).
2. Cherche les nouveautés des dernières 24 h : web_search (5-8 requêtes ciblées), x_search (3 requêtes : opérateurs lang:fr -is:retweet min_faves:5).
3. Pour chaque fait nouveau et vérifiable (prix, lancement, panne, décision juridique) : remember_fact avec source et confiance.
4. Mets à jour /memories/veille/derniers-signaux.md (max 30 lignes, les plus récents en haut).
5. Propose 3 sujets d'articles SEO à forte intention de recherche, avec mot-clé principal et angle, dans /memories/seo/backlog.md (ajoute, ne remplace pas).
Critère de succès : au moins 5 faits sourcés enregistrés, backlog SEO enrichi.`,
  },
  {
    name: "seo_daily",
    cron: "30 6 * * *",
    model: "planner",
    effort: "high",
    budgetUsd: 4,
    maxIterations: 60,
    mcpServers: ["github"],
    tools: [...CORE_TOOLS, ...SANDBOX_TOOLS, ...CLAUDE_WEB(), ...searchTools(), ensureRepoTool, coderTool, pushDeployTool],
    task: ({ now, siteUrl, repo }) => `Date: ${now.toISOString()}. Site: ${siteUrl}. Dépôt: ${repo}.
Mission ARTICLE SEO du jour.
1. git_ensure_repo (branche main). Lis la structure de contenu du site (dossier content/ ou app/blog) et /memories/seo/style.md (crée un guide de style à la première exécution : ton, longueur 1200-1800 mots, structure H2/H3, FAQ, maillage interne, méta).
2. Choisis le sujet n°1 du backlog /memories/seo/backlog.md non encore traité (vérifie /memories/seo/publies.md pour éviter les doublons et la cannibalisation).
3. Recherche 4-6 sources récentes (web_search/web_fetch). Aucun chiffre sans source.
4. Rédige l'article (frontmatter complet : title ≤ 60 car., description ≤ 155 car., slug, date, tags, sources). Ajoute 2-3 liens internes vers des pages existantes du site.
   GEO (Generative Engine Optimization, pour être cité par ChatGPT/Perplexity/AI Overviews) : réponse directe dans les 2 premières phrases de chaque H2, entités nommées explicites, chiffres datés et sourcés, FAQ en fin d'article avec schéma FAQPage JSON-LD, auteur identifié, date de mise à jour visible.
5. Délègue au codeur (delegate_coding_task) l'intégration : fichier au bon format, build (npm run build) vert, lint vert, commit.
6. git_push_and_deploy et vérifie que l'URL finale répond 200 (web_fetch).
7. Mets à jour /memories/seo/publies.md (date, slug, mot-clé) et le backlog.
Critère de succès : article en ligne, build vert, URL vérifiée.`,
  },
  {
    name: "iptv_comparator",
    cron: "0 4 * * 1,4",
    model: "planner",
    effort: "high",
    budgetUsd: 5,
    maxIterations: 80,
    mcpServers: ["github"],
    tools: [...CORE_TOOLS, ...SANDBOX_TOOLS, ...WEB_TOOLS, ensureRepoTool, coderTool, pushDeployTool],
    task: ({ now, siteUrl, repo }) => `Date: ${now.toISOString()}. Site: ${siteUrl}. Dépôt: ${repo}.
Mission MISE À JOUR DU COMPARATEUR IPTV (services légaux uniquement : offres opérateurs, plateformes de streaming, box, FAST channels).
1. git_ensure_repo. Localise la source de données du comparateur (ex: data/providers.json ou équivalent) et lis /memories/iptv/methodologie.md (crée-la à la première exécution : champs, unités, règles de scoring, sources par fournisseur).
2. Pour chaque fournisseur : recharge la page tarifaire officielle (web_fetch, puis scrape_page si la page est rendue en JS). Extrais prix, engagement, nombre de chaînes, écrans simultanés, replay, 4K, essai gratuit, date de relevé.
3. Compare avec les valeurs en mémoire (recall_facts topic_prefix 'iptv:'). Tout changement → remember_fact avec source. Une valeur non trouvée reste inchangée et est signalée « à vérifier », jamais inventée.
4. Délègue au codeur la mise à jour du fichier de données + validation de schéma + build vert + commit « data(iptv): relevé du ${now.toISOString().slice(0, 10)} ».
5. git_push_and_deploy, vérifie la page du comparateur (200 + présence des nouvelles valeurs).
6. Mets à jour /memories/iptv/changelog.md.
Critère de succès : 100 % des fournisseurs relevés ou explicitement marqués « à vérifier », déploiement vert.`,
  },
  {
    name: "inbox_calendar",
    cron: "0 7,13,18 * * 1-5",
    model: "worker",
    effort: "medium",
    budgetUsd: 1,
    maxIterations: 30,
    mcpServers: ["gmail", "gcal"],
    tools: [...CORE_TOOLS],
    task: ({ now }) => `Date: ${now.toISOString()}.
Mission BOÎTE MAIL + AGENDA.
1. Liste les e-mails non lus des dernières 12 h. Classe : urgent / à répondre / info / spam. N'envoie AUCUN e-mail (les envois sont en dry-run) : prépare des brouillons de réponse pour « à répondre » et note-les dans /memories/inbox/brouillons.md avec l'ID du message.
2. Liste les événements des prochaines 48 h. Détecte conflits, absences de lien visio, réunions sans ordre du jour ; propose des créneaux si une demande de rendez-vous est arrivée par mail.
3. Résume dans /memories/inbox/etat.md (remplace le contenu, max 40 lignes).
Critère de succès : zéro e-mail urgent non signalé.`,
  },
  {
    name: "repo_maintenance",
    cron: "0 3 * * 0",
    model: "planner",
    effort: "high",
    budgetUsd: 4,
    maxIterations: 60,
    mcpServers: ["github"],
    tools: [...CORE_TOOLS, ...SANDBOX_TOOLS, ensureRepoTool, coderTool, pushDeployTool],
    task: ({ now, repo }) => `Date: ${now.toISOString()}. Dépôt: ${repo}.
Mission MAINTENANCE HEBDO du dépôt.
1. git_ensure_repo. npm audit, npm outdated, lint, typecheck, build.
2. Corrige les vulnérabilités « high/critical » sans changement de majeure ; délègue au codeur avec tests verts obligatoires. Travaille sur une branche chore/maintenance-${now.toISOString().slice(0, 10)}.
3. Pousse la branche et ouvre une pull request via github__create_pull_request avec le détail des changements et les résultats de tests. Ne fusionne pas.
4. Note dans /memories/repo/dette.md ce qui demande une décision humaine (majeures, API dépréciées).
Critère de succès : PR ouverte avec CI verte, ou rapport « rien à faire » justifié.`,
  },
];

MISSIONS.push(
  {
    name: "competitor_watch",
    cron: "15 5 * * *",
    model: "worker",
    effort: "medium",
    budgetUsd: 2,
    maxIterations: 45,
    mcpServers: [],
    tools: [...CORE_TOOLS, ...WEB_TOOLS, alertTool],
    task: ({ now, siteUrl }) => `Date: ${now.toISOString()}. Notre site: ${siteUrl}.
Mission SURVEILLANCE CONCURRENTS (quotidienne, avec alertes).
1. Lis /memories/concurrents/liste.md (crée-la à la première exécution : 5-10 concurrents directs du comparateur, avec pour chacun URL tarifs, URL blog/actus, mots-clés cibles).
2. Pour chaque concurrent : recharge la page tarifs et la page actus (web_fetch/tavily_extract, scrape_page si JS). Extrais : offres/prix, nouveaux contenus (titres + dates), changements de structure.
3. Compare avec recall_facts (topic_prefix 'concurrent:'). Pour chaque DELTA vérifié : remember_fact (source, confiance).
4. SERP : pour 5 mots-clés cibles, relève le top 10 (serpapi_search si dispo, sinon web_search) et note nos positions vs les leurs dans /memories/concurrents/serp.md.
5. send_alert UNIQUEMENT si : baisse de prix ≥ 10 %, nouvelle offre, concurrent qui nous dépasse sur un mot-clé cible, page concurrente en erreur durable. Sinon, rien : le rapport du matin suffit.
6. Mets à jour /memories/concurrents/journal.md (deltas du jour, 20 lignes max).
Critère de succès : tous les concurrents relevés ou marqués « injoignable », zéro fausse alerte.`,
  },
  {
    name: "site_audit",
    cron: "0 2 * * 2",
    model: "planner",
    effort: "high",
    budgetUsd: 4,
    maxIterations: 50,
    mcpServers: ["github"],
    tools: [...CORE_TOOLS, ...SANDBOX_TOOLS, auditTool, ...CLAUDE_WEB(), ...searchTools(), ensureRepoTool, coderTool],
    task: ({ now, siteUrl, repo }) => `Date: ${now.toISOString()}. Site: ${siteUrl}. Dépôt: ${repo}.
Mission AUDIT DE SITE hebdomadaire (technique, SEO, contenu, données structurées, performance, conversion).
1. site_audit sur la page d'accueil, la page comparateur, 2 articles récents et 1 page profonde (mobile). Desktop sur l'accueil.
2. Technique : statuts HTTP, canonical, robots/sitemap/llms.txt, hreflang, viewport, poids HTML, images sans alt. Performance : LCP/CLS/TBT et les 3 opportunités les plus rentables.
3. SEO/GEO : titres/descriptions (longueur, doublons entre pages), H1 unique, JSON-LD valides (Organization, Article, FAQPage, Product/Offer pour le comparateur), maillage interne, contenu mince (< 300 mots).
4. Conversion : pour la page comparateur, évalue la proposition de valeur au-dessus de la ligne de flottaison, la clarté des CTA, les signaux de confiance (méthodologie, date de mise à jour, mentions légales), le temps avant première info utile. Note ce qu'un utilisateur mobile ne voit pas.
5. Compare avec /memories/audit/dernier.md ; liste les régressions et les progrès (chiffres).
6. Priorise : impact × facilité. Pour les 2 corrections les plus rentables ET sans risque (meta, JSON-LD, alt, canonical) : git_ensure_repo sur une branche fix/audit-${now.toISOString().slice(0, 10)} et délègue au codeur ; ne pousse pas — le rapport propose la PR. Le reste va dans task_board.
7. Écris /memories/audit/dernier.md (scores, régressions, top 10 actions avec estimation d'impact).
Critère de succès : 5 pages auditées avec chiffres, top 10 actions priorisées, 2 correctifs commités sur branche.`,
  },
);

MISSIONS.push({
  name: "reflect",
  cron: "30 23 * * *",
  model: "planner",
  effort: "high",
  budgetUsd: 2,
  maxIterations: 30,
  mcpServers: ["github"],
  tools: [...CORE_TOOLS, episodesTool, ...SANDBOX_TOOLS, ensureRepoTool, coderTool],
  task: ({ now, repo }) => `Date: ${now.toISOString()}. Dépôt de l'agent: ${repo}.
Mission RÉFLEXION QUOTIDIENNE — c'est ainsi que tu évolues. Tu n'es pas ré-entraîné ; tu apprends en révisant tes propres consignes de travail.
1. read_episodes(24h) : pour chaque mission, note ce qui a réussi, ce qui a échoué, ce qui a coûté trop cher ou bouclé (tours > moyenne, budget dépassé, refus, erreurs d'outil répétées).
2. Pour chaque mission avec au moins un enseignement : mets à jour /memories/playbooks/<mission>.md (crée-le si absent). Format strict, max 25 lignes par playbook :
   - RÈGLES (ce qui marche, à refaire) — avec la preuve (épisode, date)
   - PIÈGES (ce qui a échoué, à éviter) — avec la cause racine, pas le symptôme
   - RACCOURCIS (outils/requêtes/sources qui font gagner des tours)
   Une règle contredite par les faits est supprimée, pas accumulée. Un playbook est une liste vivante, pas un journal.
3. Mets à jour /memories/playbooks/_global.md (10 lignes max) : les 3 à 5 principes transverses les plus rentables du moment.
4. Le dimanche uniquement : si un enseignement exige de changer le CODE de l'agent (prompt système, cahier des charges d'une mission, nouvel outil, budget), git_ensure_repo sur une branche evolve/${now.toISOString().slice(0, 10)}, délègue la modification au codeur (fichiers sous agent/src/, typecheck vert), commit. Ne pousse pas : le rapport du matin propose la PR à l'humain, qui décide.
5. Chiffres dans /memories/playbooks/_metrics.md : taux de succès et coût moyen par mission sur 7 jours, tendance vs semaine précédente (tableau, 15 lignes max).
Critère de succès : playbooks à jour avec preuves, métriques 7 jours, aucun enseignement inventé.`,
});

export function findMission(name: string): Mission | undefined {
  return MISSIONS.find((m) => m.name === name);
}

export async function runMission(m: Mission, opts: { signal?: AbortSignal } = {}): Promise<{ text: string; usage: Usage; status: "ok" | "failed" | "budget" }> {
  const cfg = config();
  const episodeId = await openEpisode(m.name, { model: m.model, effort: m.effort });
  const log = logger.child({ mission: m.name, episode: episodeId });
  log.info("mission démarrée");

  const ctx: MissionContext = {
    now: new Date(),
    memory: await memoryDigest(),
    siteUrl: cfg.SITE_URL ?? "(non configuré)",
    repo: cfg.GITHUB_REPO,
  };
  const playbook = await memoryDigest(6_000, `/memories/playbooks/${m.name}.md`);
  const global = await memoryDigest(3_000, "/memories/playbooks/_global.md");
  const task = `<playbook>\n${global}\n${playbook}\n</playbook>\n\n${m.task(ctx)}\n\n<memoire>\n${ctx.memory}\n</memoire>`;
  const tools = [...m.tools, ...mcpToolsFor(m.mcpServers, { allowIrreversible: m.allowIrreversible })];

  try {
    const res = await runAgent({
      model: m.model === "planner" ? cfg.MODEL_PLANNER : cfg.MODEL_WORKER,
      system: OPERATOR_SYSTEM,
      task,
      tools,
      effort: m.effort,
      maxIterations: m.maxIterations,
      budgetUsd: m.budgetUsd,
      signal: opts.signal,
      onTurn: (msg, usage) => log.info({ stop: msg.stop_reason, iter: usage.iterations, usd: usage.usd.toFixed(3) }, "tour"),
    });
    const status = res.stopReason === "budget_exceeded" ? "budget" : res.stopReason === "refusal" ? "failed" : "ok";
    await closeEpisode(episodeId, status, res.finalText, res.usage, status === "ok" ? undefined : `stop=${res.stopReason}`);
    log.info({ status, usd: res.usage.usd.toFixed(3), iterations: res.usage.iterations }, "mission terminée");
    return { text: res.finalText, usage: res.usage, status };
  } catch (err) {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, iterations: 0 };
    await closeEpisode(episodeId, "failed", "", usage, String(err));
    log.error({ err: String(err) }, "mission en erreur");
    return { text: "", usage, status: "failed" };
  }
}
