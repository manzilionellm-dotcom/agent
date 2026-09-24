import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sandboxExec, shellQuote } from "./sandbox.js";
import { codeurChoisi } from "../providers.js";

/**
 * Sous-agent « codeur » : délègue une tâche de code à Claude Code en mode
 * headless (`claude -p`) DANS le sandbox. C'est le levier 80/20 : on
 * récupère gratuitement le harnais complet (lecture/édition de fichiers,
 * bash, tests, git) au lieu de le réécrire.
 *
 * Le planificateur ne voit que le résumé JSON final — pas les milliers de
 * lignes de diff — ce qui garde son contexte propre.
 */

const RESULT_SCHEMA = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  total_cost_usd: z.number().optional(),
  num_turns: z.number().optional(),
  session_id: z.string().optional(),
});

export function makeCoderTool(container?: string) {
  return betaZodTool({
    name: "delegate_coding_task",
    description:
      "Délègue une tâche de développement complète à un sous-agent codeur autonome (Claude Code) qui travaille dans le dépôt cloné sous /work/<repo>. Donne un cahier des charges complet : objectif, fichiers concernés, critères d'acceptation, commandes de test. Il commit sur la branche indiquée mais ne pousse pas ; utilise git_push_and_deploy ensuite.",
    inputSchema: z.object({
      repo_dir: z.string().describe("Chemin absolu du dépôt dans le sandbox, ex: /work/agent"),
      branch: z.string().default("main"),
      spec: z.string().min(40).describe("Cahier des charges complet, en une fois"),
      budget_usd: z.number().positive().max(20).default(2).describe("Plafond de dépense du sous-agent (coupe net au-delà)"),
    }),
    run: async (i) => {
      const cfg = config();
      // Le harnais est Claude Code ; le cerveau est celui que Lionel a choisi :
      // DeepSeek par son API compatible Anthropic, ou Claude.
      const choix = await codeurChoisi();
      if (!choix.cle) return `Error: le sous-agent codeur n'a aucune clé (${choix.raison}). Ajoute une clé DeepSeek au panneau (section Services) ou ANTHROPIC_API_KEY au .env. En attendant : sandbox_bash / sandbox_write_file.`;
      const prompt = [
        `Tu travailles dans ${i.repo_dir} sur la branche ${i.branch}.`,
        `Règles: lis AGENTS.md/CLAUDE.md s'ils existent; exécute lint/typecheck/tests avant de committer; commits atomiques avec messages clairs; ne pousse jamais (git push interdit); pas de refactor non demandé.`,
        `Termine par un résumé: fichiers modifiés, tests exécutés (résultat), ce qui reste à faire.`,
        ``,
        `TÂCHE:`,
        i.spec,
      ].join("\n");

      const cmd = [
        `cd ${shellQuote(i.repo_dir)} && (git checkout -q ${shellQuote(i.branch)} 2>/dev/null || git checkout -q -b ${shellQuote(i.branch)});`,
        `claude -p ${shellQuote(prompt)}`,
        `--output-format json`,
        `--permission-mode acceptEdits`,
        `--allowedTools "Read,Edit,Write,Glob,Grep,Bash(npm:*),Bash(npx:*),Bash(node:*),Bash(git add:*),Bash(git commit:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(pytest:*),Bash(python:*)"`,
        `--max-budget-usd ${i.budget_usd}`,
        `--model ${shellQuote(choix.modele)}`,
      ].join(" ");

      logger.info({ container, repo: i.repo_dir, branch: i.branch, codeur: choix.codeur, modele: choix.modele }, "delegate_coding_task");
      const r = await sandboxExec(cmd, {
        container,
        timeoutMs: cfg.SANDBOX_TIMEOUT_MS,
        env: {
          ANTHROPIC_API_KEY: choix.cle,
          ...(choix.base ? { ANTHROPIC_BASE_URL: choix.base } : {}),
          GIT_AUTHOR_NAME: cfg.GIT_AUTHOR_NAME,
          GIT_AUTHOR_EMAIL: cfg.GIT_AUTHOR_EMAIL,
          GIT_COMMITTER_NAME: cfg.GIT_AUTHOR_NAME,
          GIT_COMMITTER_EMAIL: cfg.GIT_AUTHOR_EMAIL,
        },
      });

      if (r.timedOut) return `Error: sous-agent codeur interrompu (timeout ${cfg.SANDBOX_TIMEOUT_MS / 1000}s). stderr: ${r.stderr.slice(-2000)}`;

      // La sortie JSON est sur la dernière ligne non vide.
      const lastLine = r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
      const parsed = RESULT_SCHEMA.safeParse(safeJson(lastLine));
      if (!parsed.success) {
        return `exit=${r.code}\n(sortie non JSON)\n${r.stdout.slice(-6000)}\n${r.stderr.slice(-2000)}`;
      }
      const d = parsed.data;
      const status = await sandboxExec(`cd ${shellQuote(i.repo_dir)} && git status --short && git log --oneline -5`, { timeoutMs: 20_000, container });
      return [
        `status=${d.is_error ? "error" : (d.subtype ?? "ok")} turns=${d.num_turns ?? "?"} cost_usd=${(d.total_cost_usd ?? 0).toFixed(3)} codeur=${choix.codeur}:${choix.modele}`,
        `--- résumé du codeur ---`,
        d.result ?? "(vide)",
        `--- git ---`,
        status.stdout.trim(),
      ].join("\n");
    },
  });
}

export const coderTool = makeCoderTool();

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
