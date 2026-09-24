import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { secretFor, vercelProject } from "../providers.js";
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

/**
 * « owner/repo » depuis ce que Lionel écrit : un lien GitHub collé, un
 * « owner/repo », ou rien (le dépôt configuré). Un nom seul est cherché
 * sous le même propriétaire que le dépôt configuré : « tvking » suffit.
 */
export function resoudreDepot(entree: string | undefined): string {
  const cfg = config();
  const s = (entree ?? "").trim();
  if (!s) return cfg.GITHUB_REPO;
  const m = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s.replace(/\.git$/, "");
  if (/^[\w.-]+$/.test(s)) return `${cfg.GITHUB_REPO.split("/")[0]}/${s}`;
  throw new Error(`dépôt illisible : « ${entree} » (attendu owner/repo ou un lien GitHub)`);
}

export function makeGitTools(container?: string) {
  const ensureRepo = betaZodTool({
    name: "git_ensure_repo",
    description: "Clone (ou met à jour) un dépôt GitHub dans le sandbox sous /work/<repo> et se place sur la branche demandée. `repo` : owner/repo, un lien GitHub, ou un nom seul (même propriétaire) ; sans lui, le dépôt configuré. Retourne le chemin et l'état git.",
    inputSchema: z.object({ branch: z.string().default("main"), repo: z.string().optional() }),
    run: async (i) => {
      const cfg = config();
      const depot = resoudreDepot(i.repo);
      const name = depot.split("/")[1]!;
      const dir = `${cfg.SANDBOX_WORKDIR}/${name}`;
      const gh = (await secretFor("github", cfg.GITHUB_TOKEN)) ?? cfg.GITHUB_TOKEN;
      const authed = `https://x-access-token:${gh}@github.com/${depot}.git`;
      const cmd = [
        `if [ ! -d ${shellQuote(dir)}/.git ]; then git clone -q ${shellQuote(authed)} ${shellQuote(dir)}; fi`,
        `cd ${shellQuote(dir)}`,
        `git remote set-url origin https://github.com/${depot}.git`,
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
      repo: z.string().optional().describe("owner/repo ou lien GitHub ; sans lui, le dépôt configuré"),
      wait_for_deploy_seconds: z.number().int().min(0).max(900).default(300),
    }),
    run: async (i) => {
      const cfg = config();
      const gh = (await secretFor("github", cfg.GITHUB_TOKEN)) ?? cfg.GITHUB_TOKEN;
      const authed = `https://x-access-token:${gh}@github.com/${resoudreDepot(i.repo)}.git`;
      const push = await sandboxExec(
        `cd ${shellQuote(i.repo_dir)} && git push -q ${shellQuote(authed)} HEAD:${shellQuote(i.branch)} 2>&1 && git rev-parse HEAD`,
        { timeoutMs: 120_000, container },
      );
      const pushOut = formatExec(push).replaceAll(gh, "***");
      if (push.code !== 0) return `Push échoué:\n${pushOut}`;
      const sha = push.stdout.trim().split("\n").at(-1) ?? "";
      logger.info({ container, sha, branch: i.branch }, "pushed");

      const vercel = (await secretFor("vercel", cfg.VERCEL_TOKEN)) ?? cfg.VERCEL_TOKEN;
      const projet = await vercelProject();
      if (!vercel || !projet || i.wait_for_deploy_seconds === 0) {
        return `Poussé ${sha} sur ${i.branch}.\n${pushOut}`;
      }
      const deadline = Date.now() + i.wait_for_deploy_seconds * 1000;
      let lastState = "UNKNOWN";
      let url = "";
      while (Date.now() < deadline) {
        const res = await fetch(`https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projet)}&limit=5`, {
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

  return { ensureRepo, pushDeploy, pullRequest: pullRequestTool, all: [ensureRepo, pushDeploy, pullRequestTool] };
}

/**
 * Ouvre une pull request par l'API GitHub. C'est ainsi qu'un correctif du
 * bot arrive devant Lionel : une branche, une PR à relire, jamais un
 * commit direct sur la branche principale de son site.
 */
export async function ouvrirPullRequest(p: { repo?: string; head: string; base?: string; title: string; body?: string }, f: typeof fetch = fetch): Promise<{ url: string; numero: number }> {
  const cfg = config();
  const depot = resoudreDepot(p.repo);
  const gh = (await secretFor("github", cfg.GITHUB_TOKEN)) ?? cfg.GITHUB_TOKEN;
  const headers = { authorization: `Bearer ${gh}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "manzi-junior" };
  let base = p.base;
  if (!base) {
    const r = await f(`https://api.github.com/repos/${depot}`, { headers });
    if (!r.ok) throw new Error(`dépôt ${depot} inaccessible (HTTP ${r.status})`);
    base = ((await r.json()) as { default_branch?: string }).default_branch ?? "main";
  }
  const res = await f(`https://api.github.com/repos/${depot}/pulls`, { method: "POST", headers, body: JSON.stringify({ title: p.title.slice(0, 200), head: p.head, base, body: (p.body ?? "").slice(0, 60_000) }) });
  const j = (await res.json().catch(() => ({}))) as { html_url?: string; number?: number; message?: string; errors?: Array<{ message?: string }> };
  if (!res.ok) throw new Error(`création de la PR refusée (HTTP ${res.status}) : ${j.message ?? ""} ${(j.errors ?? []).map((e) => e.message).join("; ")}`.trim());
  if (!j.html_url) throw new Error("GitHub n'a pas rendu de lien de PR");
  logger.info({ depot, head: p.head, base, url: j.html_url }, "pull request ouverte");
  return { url: j.html_url, numero: j.number ?? 0 };
}

export const pullRequestTool = betaZodTool({
  name: "git_pull_request",
  description: "Ouvre une pull request sur GitHub pour une branche déjà poussée : titre, description (ce qui change, pourquoi, comment c'est testé). Rend le lien. La branche de base par défaut est celle du dépôt.",
  inputSchema: z.object({
    repo: z.string().optional().describe("owner/repo ou lien GitHub ; sans lui, le dépôt configuré"),
    head: z.string().min(1).describe("La branche poussée, ex. manzi/seo-title-fix"),
    base: z.string().optional(),
    title: z.string().min(3).max(200),
    body: z.string().max(60_000).optional(),
  }),
  run: async (i) => {
    try {
      const r = await ouvrirPullRequest(i);
      return `PR #${r.numero} ouverte : ${r.url}`;
    } catch (e) {
      return `Error: ${String(e).slice(0, 300)}`;
    }
  },
});

const defaults = makeGitTools();
export const ensureRepoTool = defaults.ensureRepo;
export const pushDeployTool = defaults.pushDeploy;
