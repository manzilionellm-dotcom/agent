import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { Mission } from "./missions/index.js";
import { memoryTool, rememberFact, recallFacts, taskTool } from "./memory/store.js";
import { bashTool, readFileTool, writeFileTool } from "./tools/sandbox.js";
import { auditTool } from "./tools/audit.js";
import { lireCodeSiteTool } from "./tools/code-site.js";
import { scrapePageTool, webFetchTool, webSearchTool } from "./tools/web.js";
import { searchToolsAsync } from "./tools/search.js";
import { browserTool, vaultListTool } from "./tools/browser.js";
import { ensureRepoTool, pullRequestTool, pushDeployTool, resoudreDepot } from "./tools/git.js";
import { coderTool } from "./tools/coder.js";

/**
 * L'atelier de développement — ce que Grok Build ou Cursor font sur un
 * ordre : « regarde le code de ces sites concurrents, compare avec le mien,
 * corrige, ouvre une PR ». Depuis WhatsApp, en arrière-plan, avec un rapport
 * à la fin.
 *
 * C'est une mission construite à la volée : même moteur que les missions
 * planifiées (budget borné par le reste du jour, verrou, juge, boîte noire),
 * mais la consigne vient de Lionel et le dépôt peut être n'importe lequel
 * des siens. Modèle « critical » : c'est du code qui part en production, on
 * ne l'économise pas.
 *
 * Règle de sécurité, écrite dans la consigne et dans les outils : jamais de
 * commit direct sur la branche principale. Une branche manzi/…, un push, une
 * pull request. Lionel relit et fusionne d'un clic ; le bot ne fusionne pas.
 */

export const BUDGET_DEV_USD = 4;
const SLUG_MAX = 40;

export function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX) || "travail";
}

export type DemandeDev = { tache: string; depot?: string; sites?: string[]; pousser?: boolean };

export async function missionDev(d: DemandeDev): Promise<Mission> {
  // Sans dépôt nommé, on n'en prend un que si la demande est un CHANGEMENT
  // (« corrige », « ajoute »…). « Compare avec mon site » est une analyse.
  const changement = /\b(corrige[sz]?|répare|repare|ajoute[sz]?|modifie[sz]?|implémente|implemente|déploie|deploie|améliore|ameliore|refais|refactor|crée|cree|mets? à jour|met à jour|supprime|renomme|optimise)\b/i;
  const depot = d.depot || (changement.test(d.tache) ? config().GITHUB_REPO : undefined);
  const resolu = depot ? resoudreDepot(depot) : undefined;
  const branche = `manzi/${new Date().toISOString().slice(0, 10)}-${slug(d.tache).slice(0, 28)}`;
  const web = await searchToolsAsync();
  const claude = config().LLM_PROVIDER_CRITICAL === "anthropic" || config().LLM_PROVIDER === "anthropic" ? [webSearchTool, webFetchTool] : [];
  const sites = (d.sites ?? []).filter((s) => /^https?:\/\//i.test(s)).slice(0, 8);
  const nom = `dev-${Date.now().toString(36)}`;
  const task = () =>
    [
      `Date : ${new Date().toLocaleString("fr-FR", { timeZone: config().TZ, dateStyle: "full", timeStyle: "short" })}.`,
      `ATELIER DE DÉVELOPPEMENT, sur ordre de Lionel (WhatsApp). Sa demande, mot pour mot :`,
      `« ${d.tache} »`,
      sites.length ? `Sites à examiner : ${sites.join(", ")}` : "",
      resolu ? `Dépôt de travail : ${resolu} (branche de travail : ${branche}).` : "Aucun dépôt désigné : c'est une analyse, tu ne modifies pas de code.",
      config().SITE_URL ? `Notre site : ${config().SITE_URL}.` : "",
      ``,
      `MÉTHODE :`,
      `1. Comprendre avant d'agir. Pour chaque site cité : lire_code_site (pile, services, SEO, structure, signaux commerciaux), puis site_audit sur la page d'accueil (mobile) si les scores comptent pour la demande, et scrape_page ou browser pour les pages qui se construisent en JavaScript. Note ce qu'ils font mieux que nous et ce qu'ils font moins bien, en faits observés (balises, chiffres, textes), jamais en impressions.`,
      `2. Chercher quand il manque une référence : bonnes pratiques, documentation d'un framework, règles d'une plateforme. Une affirmation technique s'appuie sur une source lue.`,
      resolu
        ? [
            `3. Coder. git_ensure_repo{repo:"${resolu}", branch:"${branche}"} (la branche est créée depuis la branche par défaut). Lis AGENTS.md / CLAUDE.md / README s'ils existent, repère où vit ce qu'il faut changer (sandbox_bash : grep, ls, cat). Puis delegate_coding_task avec un cahier des charges précis : objectif, fichiers, critères d'acceptation, commandes de test. Un changement à la fois, petit, testé. Pas de refonte non demandée. Jamais de secret dans le code.`,
            `4. Vérifier : lint, typecheck, tests, build (sandbox_bash). Si ça casse, corrige avant de pousser. Si un test échoue pour une raison étrangère à ton changement, dis-le dans le rapport, ne le désactive pas.`,
            d.pousser === false
              ? `5. NE POUSSE PAS : Lionel a demandé de préparer sans publier. Laisse les commits sur la branche locale et décris-les.`
              : `5. Publier : git_push_and_deploy{repo:"${resolu}", repo_dir:"/work/${resolu.split("/")[1]}", branch:"${branche}", wait_for_deploy_seconds:0} puis git_pull_request{repo:"${resolu}", head:"${branche}", title, body} avec dans le corps : ce qui change, pourquoi (avec les observations des sites concurrents s'il y en a), comment c'est testé, ce qui reste à faire. Tu ne fusionnes jamais toi-même et tu ne touches jamais à la branche principale.`,
          ].join("\n")
        : `3. Rendre une analyse utile : tableau comparatif en texte (site par site : pile, ce qui convertit, ce qui manque chez nous), puis les 5 actions les plus rentables pour notre site, classées impact × facilité, chacune en une ligne avec ce qu'il faut changer concrètement.`,
      ``,
      `RAPPORT FINAL (c'est ce que Lionel lira sur WhatsApp, 15 à 30 lignes, texte simple) :`,
      `- ce que tu as observé (faits, chiffres) ;`,
      resolu ? `- ce que tu as changé (fichiers, en une ligne chacun), les tests passés, le lien de la PR ;` : `- les 5 actions recommandées ;`,
      `- ce que tu n'as pas pu faire et pourquoi.`,
      `Critère de succès : ${resolu ? "une PR ouverte avec des tests verts, ou une explication précise de ce qui a bloqué" : "une comparaison chiffrée et 5 actions concrètes"}.`,
    ]
      .filter(Boolean)
      .join("\n");

  const m: Mission = {
    name: nom,
    cron: "",
    model: resolu ? "critical" : "planner",
    effort: "high",
    budgetUsd: BUDGET_DEV_USD,
    maxIterations: 70,
    mcpServers: resolu ? ["github"] : [],
    tools: [
      memoryTool, rememberFact, recallFacts, taskTool,
      bashTool, readFileTool, writeFileTool,
      lireCodeSiteTool, auditTool, scrapePageTool, browserTool, vaultListTool,
      ...claude, ...web,
      ...(resolu ? [ensureRepoTool, coderTool, pushDeployTool, pullRequestTool] : []),
    ],
    task,
  };
  return m;
}

/** L'outil de chat : construit la mission, la lance, répond tout de suite. */
export function outilDev(notify: (t: string) => Promise<void>, lancer: (m: Mission, opts: { brief?: string }) => Promise<{ text: string; status: string; usage: { usd: number } } | undefined>) {
  return betaZodTool({
    name: "travail_dev",
    description:
      "Atelier de développement en arrière-plan (10 à 30 minutes) : « regarde le code de ces sites concurrents et compare avec le mien », « corrige X sur mon site », « ajoute une page Y », « analyse ce dépôt GitHub et améliore Z ». Il lit le code des sites, cherche ce qu'il faut, clone le dépôt, code sur une branche, teste, pousse et ouvre une pull request que Lionel relit. Il ne fusionne jamais. Donne la demande de Lionel telle quelle dans `tache`, les URL des sites dans `sites`, le dépôt (owner/repo ou lien) dans `depot` s'il l'a nommé. Réponds ensuite en une ligne : lancé, rapport à venir.",
    inputSchema: z.object({
      tache: z.string().min(10).max(3_000).describe("La demande, complète, telle que Lionel l'a formulée (reformule seulement pour la clarté)"),
      sites: z.array(z.string().url()).max(8).optional().describe("Sites à examiner (concurrents, le nôtre)"),
      depot: z.string().max(200).optional().describe("Dépôt GitHub : owner/repo, lien, ou nom seul. Omets-le pour une simple analyse."),
      pousser: z.boolean().optional().describe("false = préparer les commits sans pousser ni ouvrir de PR"),
    }),
    run: async (i) => {
      let m: Mission;
      try {
        m = await missionDev({ tache: i.tache, sites: i.sites, depot: i.depot, pousser: i.pousser });
      } catch (e) {
        return `Error: ${String(e).slice(0, 200)}`;
      }
      const depot = m.mcpServers.includes("github") ? resoudreDepot(i.depot) : undefined;
      if (depot && !config().ANTHROPIC_API_KEY) return "Error: le codeur (Claude Code) a besoin d'une clé Anthropic sur le serveur : ANTHROPIC_API_KEY absente. L'analyse des sites reste possible sans dépôt.";
      void lancer(m, {})
        .then((r) =>
          r
            ? notify(`🛠️ Atelier terminé (${r.status}, ${r.usage.usd.toFixed(2)} $)${depot ? ` sur ${depot}` : ""}.\n\n${r.text.slice(0, 3_500)}`)
            : notify("🛠️ Atelier non lancé : plafond du jour atteint ou jeton GitHub inutilisable (voir panneau, section Services)."),
        )
        .catch((e) => notify(`❌ Atelier en erreur : ${String(e).slice(0, 200)}`));
      logger.info({ mission: m.name, depot, sites: i.sites?.length ?? 0 }, "atelier dev lancé depuis le chat");
      return `atelier lancé${depot ? ` sur ${depot} (branche manzi/…, PR à la fin)` : " (analyse seule)"} — budget ${BUDGET_DEV_USD} $, 10 à 30 minutes. Confirme en une ligne.`;
    },
  });
}
