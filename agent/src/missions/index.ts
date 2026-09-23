import { dansTrace, enregistrer } from "../boite-noire.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { config } from "../config.js";
import { runAgent, resolveModel, structured, type Effort, type Usage } from "../llm.js";
import { logger } from "../logger.js";
import { OPERATOR_SYSTEM } from "../prompts.js";
import { memoryTool, memoryDigest, rememberFact, recallFacts, taskTool, episodesTool, feedbackTool, openEpisode, closeEpisode } from "../memory/store.js";
import { mcpToolsFor } from "../mcp/registry.js";
import { bashTool, readFileTool, writeFileTool } from "../tools/sandbox.js";
import { coderTool } from "../tools/coder.js";
import { ensureRepoTool, pushDeployTool } from "../tools/git.js";
import { webSearchTool, webFetchTool, scrapePageTool } from "../tools/web.js";
import { xProfileTool } from "../tools/x.js";
import { searchTools } from "../tools/search.js";
import { auditTool } from "../tools/audit.js";
import { alertTool } from "../tools/notify.js";
import { browserTool, vaultListTool } from "../tools/browser.js";
import { marketTools } from "../tools/market.js";
import { googleTools } from "../tools/google.js";
import { getCustomMission, type CustomMissionRow, type Toolset } from "./custom.js";

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
  /** critical = écrit du code et/ou déploie → fournisseur/modèle critiques (Claude en mode éco). */
  model: "planner" | "worker" | "critical";
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
const WEB_TOOLS = [...CLAUDE_WEB(), ...searchTools(), scrapePageTool, browserTool, vaultListTool, ...marketTools, xProfileTool];

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
2. Cherche les nouveautés des dernières 24 h : web_search (5-8 requêtes ciblées), x_profile (profils X des concurrents et médias listés dans /memories/veille/sources.md ; best-effort, gratuit).
3. Pour chaque fait nouveau et vérifiable (prix, lancement, panne, décision juridique) : remember_fact avec source et confiance.
4. Mets à jour /memories/veille/derniers-signaux.md (max 30 lignes, les plus récents en haut).
5. Propose 3 sujets d'articles SEO à forte intention de recherche, avec mot-clé principal et angle, dans /memories/seo/backlog.md (ajoute, ne remplace pas).
Critère de succès : au moins 5 faits sourcés enregistrés, backlog SEO enrichi.`,
  },
  {
    name: "seo_daily",
    cron: "30 6 * * *",
    model: "critical",
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
4b. Contrôle d'originalité et de cannibalisation : cherche (web_search/tavily_search) deux phrases distinctives de ton article entre guillemets ; si l'une existe déjà en ligne, reformule. Vérifie qu'aucune page existante du site ne cible déjà le même mot-clé principal (sinon, enrichis l'existante au lieu d'en créer une nouvelle).
5. Délègue au codeur (delegate_coding_task) l'intégration : fichier au bon format, build (npm run build) vert, lint vert, commit.
6. git_push_and_deploy et vérifie que l'URL finale répond 200 (web_fetch).
7. Mets à jour /memories/seo/publies.md (date, slug, mot-clé) et le backlog.
Critère de succès : article en ligne, build vert, URL vérifiée.`,
  },
  {
    name: "iptv_comparator",
    cron: "0 4 * * 1,4",
    model: "critical",
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
    mcpServers: [],
    tools: [...CORE_TOOLS, ...googleTools()],
    task: ({ now }) => `Date: ${now.toISOString()}.
Mission BOÎTE MAIL + AGENDA.
1. gmail_list avec « is:unread newer_than:1d ». Pour chaque message qui n'est manifestement pas une promotion, gmail_read. Classe : urgent / à répondre / info / pub.
2. Pour tout message « à répondre » : gmail_draft, RÉDIGÉ DANS LA LANGUE DU MESSAGE reçu (suédois, anglais, français, autre — tu réponds dans la sienne, jamais dans la tienne). Reprends in_reply_to et thread_id donnés par gmail_read, sinon le destinataire reçoit un message détaché du fil. N'envoie rien : le brouillon attend dans Gmail.
3. Repère les fils où l'opérateur attend une réponse et où elle est arrivée depuis la dernière exécution — c'est ce qu'il veut savoir en premier.
4. calendar_events sur les prochaines 48 h. Signale conflits, visioconférences sans lien, et propose des créneaux si un mail demande un rendez-vous.
5. Écris dans /memories/inbox/etat.md (remplace, max 40 lignes) : urgents, réponses reçues, brouillons prêts, agenda.
Critère de succès : aucun e-mail urgent passé sous silence, un brouillon prêt pour chaque message qui en attend un.`,
  },
  {
    name: "repo_maintenance",
    cron: "0 3 * * 0",
    model: "critical",
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
    tools: [...CORE_TOOLS, ...SANDBOX_TOOLS, auditTool, browserTool, vaultListTool, ...CLAUDE_WEB(), ...searchTools(), ensureRepoTool, coderTool],
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
  tools: [...CORE_TOOLS, episodesTool, feedbackTool, ...SANDBOX_TOOLS, ensureRepoTool, coderTool],
  task: ({ now, repo }) => `Date: ${now.toISOString()}. Dépôt de l'agent: ${repo}.
Mission RÉFLEXION QUOTIDIENNE — c'est ainsi que tu évolues. Tu n'es pas ré-entraîné ; tu apprends en révisant tes propres consignes de travail.
0. read_feedback(7 jours) : les 👍/👎 de l'opérateur priment sur ton propre jugement. Un 👎 avec commentaire devient une règle ou un piège dans le playbook concerné.
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

/** Outils accordés à une mission créée par l'opérateur, selon le préréglage choisi. */
// Les outils Google suivent « recherche » et « complet » : une mission que
// l'opérateur invente — chercher du travail, suivre une commande, relancer un
// devis — commence presque toujours par une alerte ou un échange reçu par
// courriel. Les lui refuser l'obligerait à recopier ses mails à la main.
// `googleTools()` rend une liste vide tant que Google n'est pas configuré.
const TOOLSET_IMPL: Record<Toolset, () => Mission["tools"]> = {
  recherche: () => [...CORE_TOOLS, ...WEB_TOOLS, ...googleTools()],
  code: () => [...CORE_TOOLS, ...SANDBOX_TOOLS],
  complet: () => [...CORE_TOOLS, ...WEB_TOOLS, ...SANDBOX_TOOLS, ...googleTools()],
};

/** Une ligne de `custom_missions` devient une Mission ordinaire : même moteur, mêmes garde-fous. */
export function customToMission(r: CustomMissionRow): Mission {
  return {
    name: r.name,
    cron: "", // jamais planifiée d'office : seul un ordre explicite la met dans `schedules`
    model: r.model,
    effort: "medium",
    budgetUsd: r.budget_usd,
    maxIterations: r.max_iterations,
    mcpServers: [],
    allowIrreversible: r.allow_irreversible,
    tools: TOOLSET_IMPL[r.toolset](),
    task: ({ now }) =>
      `Date: ${now.toISOString()}.
Mission « ${r.name} », définie par l'opérateur le ${String(r.created_at).slice(0, 10)}.

${r.objective}

Si l'objectif est ambigu, retiens la lecture la plus utile et dis-le dans ton compte rendu.
Termine par un compte rendu court : ce qui a été fait, ce qui a échoué, ce qui reste.`,
  };
}

/** Missions intégrées d'abord, puis celles que l'opérateur a créées. */
export async function resolveMission(name: string): Promise<Mission | undefined> {
  return findMission(name) ?? (await getCustomMission(name).then((r) => (r ? customToMission(r) : undefined)));
}

/**
 * La consigne du jour, écrite par l'opérateur au moment où il lance la mission.
 *
 * Elle est injectée ici plutôt que dans chaque `task()` : une mission décrit un
 * métier durable (« écrire l'article SEO du jour »), la consigne décrit une
 * intention ponctuelle (« aujourd'hui on vend à Uppsala »). Les mélanger
 * obligerait à modifier neuf gabarits pour ajouter une variable, et à les
 * remodifier à chaque mission créée depuis WhatsApp.
 *
 * Sa précédence est dite explicitement : sans cela le modèle suit le gabarit,
 * qui est plus long et plus détaillé, et la consigne est traitée comme une
 * remarque de contexte.
 */
export function withBrief(task: string, brief?: string): string {
  if (!brief?.trim()) return task;
  return `${task}

<consigne_de_l_operateur>
${brief.trim()}
</consigne_de_l_operateur>
Cette consigne est l'ordre du jour. Là où elle contredit les étapes ci-dessus — sujet, cible, angle, ton, priorité — c'est elle qui prime. Le reste du mode opératoire (sources, vérifications, critère de succès, publication) reste dû.`;
}

export async function runMission(m: Mission, opts: { signal?: AbortSignal; brief?: string } = {}): Promise<{ text: string; usage: Usage; status: "ok" | "failed" | "budget" }> {
  return dansTrace("mission", m.name, async () => {
    const r = await runMissionBrut(m, opts);
    enregistrer({
      type: "mission",
      titre: `Mission ${m.name} : ${r.status === "ok" ? "réussie" : r.status === "budget" ? "budget épuisé" : "échec"}`,
      detail: r.text.slice(-1500),
      ok: r.status === "ok",
    });
    return r;
  });
}

async function runMissionBrut(m: Mission, opts: { signal?: AbortSignal; brief?: string }): Promise<{ text: string; usage: Usage; status: "ok" | "failed" | "budget" }> {
  const cfg = config();
  const target = resolveModel(m.model);
  const episodeId = await openEpisode(m.name, { model: target.model, provider: target.provider, effort: m.effort });
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
  const task = `<playbook>\n${global}\n${playbook}\n</playbook>\n\n${withBrief(m.task(ctx), opts.brief)}\n\n<memoire>\n${ctx.memory}\n</memoire>`;
  const tools = [...m.tools, ...mcpToolsFor(m.mcpServers, { allowIrreversible: m.allowIrreversible })];

  // Timeout mural : une mission qui traîne (site qui ne répond pas, build infini) est arrêtée proprement.
  const timeout = AbortSignal.timeout(cfg.MISSION_TIMEOUT_MIN * 60_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    const res = await runAgent({
      model: target.model,
      provider: target.provider,
      system: OPERATOR_SYSTEM,
      task,
      tools,
      effort: m.effort,
      maxIterations: m.maxIterations,
      budgetUsd: m.budgetUsd,
      signal,
      onTurn: (msg, usage) => log.info({ stop: msg.stop_reason, iter: usage.iterations, usd: usage.usd.toFixed(3) }, "tour"),
    });
    let status: "ok" | "failed" | "budget" = res.stopReason === "budget_exceeded" ? "budget" : ["refusal", "loop_detected", "timeout"].includes(res.stopReason ?? "") ? "failed" : "ok";
    let text = res.finalText;

    // Vérification indépendante : un « juge » relit le résumé final contre le cahier des charges.
    // Il ne peut pas voir ce que l'agent n'a pas rapporté, mais il attrape les missions qui
    // déclarent « fait » sans preuve (URL, sortie de commande, chiffre). Coût ≈ 0,01 $.
    if (cfg.VERIFY_MISSIONS && status === "ok") {
      const verdict = await verify(m, text).catch((e) => (log.warn({ err: String(e) }, "juge indisponible"), undefined));
      if (verdict) {
        res.usage.usd += verdict.usd;
        text += `\n\n<verification>\nscore=${verdict.score}/10 ${verdict.pass ? "PASS" : "FAIL"}\n${verdict.issues.map((i) => `- ${i}`).join("\n") || "- rien à signaler"}\n</verification>`;
        if (!verdict.pass) {
          status = "failed";
          log.warn({ score: verdict.score, issues: verdict.issues }, "mission rejetée par le juge");
        }
      }
    }
    await closeEpisode(episodeId, status, text, res.usage, status === "ok" ? undefined : `stop=${res.stopReason}`);
    log.info({ status, usd: res.usage.usd.toFixed(3), iterations: res.usage.iterations, stop: res.stopReason }, "mission terminée");
    return { text, usage: res.usage, status };
  } catch (err) {
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, iterations: 0 };
    await closeEpisode(episodeId, "failed", "", usage, String(err));
    log.error({ err: String(err) }, "mission en erreur");
    return { text: "", usage, status: "failed" };
  }
}

type Verdict = { score: number; pass: boolean; issues: string[]; usd: number };

/** Juge indépendant (modèle worker, effort bas) : preuves présentes ? critères de succès atteints ? rien d'inventé ? */
async function verify(m: Mission, finalText: string): Promise<Verdict> {
  const spec = m.task({ now: new Date(), memory: "", siteUrl: config().SITE_URL ?? "", repo: config().GITHUB_REPO });
  const { value, usd } = await structured<{ score: number; pass: boolean; issues: string[] }>({
    ...resolveModel("worker"),
    effort: "low",
    system:
      "Tu es un vérificateur sévère mais juste. On te donne le cahier des charges d'une mission et le compte rendu final de l'agent. Note de 0 à 10 : le critère de succès est-il atteint avec des PREUVES concrètes (URL, sortie de commande, chiffres sourcés, fichiers nommés) ? Un compte rendu qui affirme sans preuve, contredit le cahier des charges, ou contient des chiffres non sourcés est pénalisé. pass = score ≥ 6. Liste les problèmes en une ligne chacun (max 6). Ne juge pas le style.",
    schema: {
      type: "json_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["score", "pass", "issues"],
        properties: { score: { type: "integer", minimum: 0, maximum: 10 }, pass: { type: "boolean" }, issues: { type: "array", items: { type: "string" }, maxItems: 6 } },
      },
    },
    prompt: `<cahier_des_charges>\n${spec.slice(0, 6000)}\n</cahier_des_charges>\n\n<compte_rendu>\n${finalText.slice(0, 12_000) || "(vide)"}\n</compte_rendu>`,
  });
  return { ...value, usd };
}
