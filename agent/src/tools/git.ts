import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { secretFor } from "../providers.js";
import { logger } from "../logger.js";
import { sandboxExec, formatExec, shellQuote } from "./sandbox.js";

/**
 * GitHub + Vercel par le chemin le plus court : `git push` sur une branche
 * connectée à Vercel = déploiement. Le token GitHub n'est jamais écrit sur
 * disque : il est injecté dans l'URL au moment du fetch/push seulement.
 *
 * Les opérations riches (issues, PR, reviews) passent par le serveur MCP GitHub
 * (voir mcp.json) ; ici on garde uniquement le chemin critique et audité.
 */

export function makeGitTools(container?: string) {
  const ensureRepo = betaZodTool({
    name: "git_ensure_repo",
    description: "Clone (ou met à jour) le dépôt GitHub configuré dans le sandbox sous /work/<repo>. Retourne le chemin et l'état git.",
    inputSchema: z.object({ branch: z.string().default("main") }),
    run: async (i) => {
      const cfg = config();
      const name = cfg.GITHUB_REPO.split("/")[1]!;
      const dir = `${cfg.SANDBOX_WORKDIR}/${name}`;
      const gh = (await secretFor("github", cfg.GITHUB_TOKEN)) ?? cfg.GITHUB_TOKEN;
      const authed = `https://x-access-token:${gh}@github.com/${cfg.GITHUB_REPO}.git`;
      const cmd = [
        `if [ ! -d ${shellQuote(dir)}/.git ]; then git clone -q ${shellQuote(authed)} ${shellQuote(dir)}; fi`,
        `cd ${shellQuote(dir)}`,
        `git remote set-url origin https://github.com/${cfg.GITHUB_REPO}.git`,
        `git fetch -q ${shellQuote(authed)} '+refs/heads/*:refs/remotes/origin/*'`,
        `(git checkout -q ${shellQuote(i.branch)} 2>/dev/null || git checkout -q -b ${shellQuote(i.branch)} origin/${shellQuote(i.branch)} 2>/dev/null || git checkout -q -b ${shellQuote(i.branch)})`,
        `(git merge -q --ff-only origin/${shellQuote(i.branch)} 2>/dev/null || true)`,
        `git config user.name ${shellQuote(cfg.GIT_AUTHOR_NAME)} && git config user.email ${shellQuote(cfg.GIT_AUTHOR_EMAIL)}`,
        `echo "dir=${dir}" && git status --short --branch && git log --oneline -3`,
      ].join(" && ");
      const r = await sandboxExec(cmd, { timeoutMs: 180_000, container });
      return formatExec(r).replaceAll(gh, "***");
    },
  });

  const pushDeploy = betaZodTool({
    name: "git_push_and_deploy",
    description:
      "Pousse la branche courante vers GitHub (fast-forward uniquement, jamais de force). Si la branche est connectée à Vercel, le déploiement démarre automatiquement ; l'outil attend et retourne l'URL et l'état du dernier déploiement quand VERCEL_TOKEN est configuré.",
    inputSchema: z.object({
      repo_dir: z.string(),
      branch: z.string().default("main"),
      wait_for_deploy_seconds: z.number().int().min(0).max(900).default(300),
    }),
    run: async (i) => {
      const cfg = config();
      const gh = (await secretFor("github", cfg.GITHUB_TOKEN)) ?? cfg.GITHUB_TOKEN;
      const authed = `https://x-access-token:${gh}@github.com/${cfg.GITHUB_REPO}.git`;
      const push = await sandboxExec(
        `cd ${shellQuote(i.repo_dir)} && git push -q ${shellQuote(authed)} HEAD:${shellQuote(i.branch)} 2>&1 && git rev-parse HEAD`,
        { timeoutMs: 120_000, container },
      );
      const pushOut = formatExec(push).replaceAll(gh, "***");
      if (push.code !== 0) return `Push échoué:\n${pushOut}`;
      const sha = push.stdout.trim().split("\n").at(-1) ?? "";
      logger.info({ container, sha, branch: i.branch }, "pushed");

      const vercel = (await secretFor("vercel", cfg.VERCEL_TOKEN)) ?? cfg.VERCEL_TOKEN;
      if (!vercel || !cfg.VERCEL_PROJECT || i.wait_for_deploy_seconds === 0) {
        return `Poussé ${sha} sur ${i.branch}.\n${pushOut}`;
      }
      const deadline = Date.now() + i.wait_for_deploy_seconds * 1000;
      let lastState = "UNKNOWN";
      let url = "";
      while (Date.now() < deadline) {
        const res = await fetch(`https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(cfg.VERCEL_PROJECT)}&limit=5`, {
          headers: { Authorization: `Bearer ${vercel}` },
        });
        if (res.ok) {
          const data = (await res.json()) as { deployments?: Array<{ url: string; state: string; meta?: Record<string, string> }> };
          const d = data.deployments?.find((x) => x.meta?.githubCommitSha === sha);
          if (d) {
            lastState = d.state;
            url = d.url;
            if (["READY", "ERROR", "CANCELED"].includes(d.state)) break;
          }
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
      return `Poussé ${sha} sur ${i.branch}. Vercel: state=${lastState}${url ? ` url=https://${url}` : ""}`;
    },
  });

  return { ensureRepo, pushDeploy, all: [ensureRepo, pushDeploy] };
}

const defaults = makeGitTools();
export const ensureRepoTool = defaults.ensureRepo;
export const pushDeployTool = defaults.pushDeploy;
