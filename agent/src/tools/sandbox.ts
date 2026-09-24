import { spawn } from "node:child_process";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { redactSecrets } from "../safety.js";

/**
 * Sandbox : toute exécution de code passe par `docker exec` dans un conteneur
 * dédié (services `sandbox*` du docker-compose) :
 *   - le modèle n'a accès qu'à cet outil, qui ne fait que `docker exec <conteneur fixe>` ;
 *     le nom du conteneur est choisi par l'orchestrateur (pool), jamais par le modèle ;
 *   - CPU/RAM limités, capacités vidées, système de fichiers éphémère hors /work ;
 *   - timeout dur + plafond de sortie (les logs interminables tuent le contexte).
 *
 * Mode essaim : chaque sous-agent reçoit SON conteneur (voir `SANDBOX_POOL`),
 * donc son propre clone git, son propre node_modules, zéro conflit.
 */

const MAX_OUTPUT = 40_000;

export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type ExecOptions = {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  container?: string;
  /**
   * Données envoyées sur l'entrée standard du processus.
   *
   * C'est le SEUL chemin acceptable pour un secret. Un argument de commande
   * est lisible dans `ps` et dans /proc/<pid>/cmdline par tout ce qui tourne
   * à côté — or ce qui tourne à côté, dans le sandbox, c'est du code écrit
   * par un modèle. Une variable d'environnement est à peine mieux : elle
   * reste dans /proc/<pid>/environ tant que le processus vit.
   */
  stdin?: string;
  /** Plafond de sortie pour CET appel, quand on attend un fichier encodé en base64 et non un journal. */
  maxOutput?: number;
};

export async function sandboxExec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const cfg = config();
  const cwd = opts.cwd ?? cfg.SANDBOX_WORKDIR;
  const container = opts.container ?? cfg.SANDBOX_CONTAINER;
  const args = ["exec", "-w", cwd];
  if (opts.stdin !== undefined) args.push("-i");
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(container, "bash", "-lc", cmd);

  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (opts.stdin !== undefined && child.stdin) {
      // `error` sur stdin : si le conteneur est mort, écrire déclenche EPIPE,
      // qui sans écouteur tue l'orchestrateur au lieu de rendre une erreur.
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.stdin);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? cfg.SANDBOX_TIMEOUT_MS);
    const max = opts.maxOutput ?? MAX_OUTPUT;
    child.stdout?.on("data", (d) => (stdout = cap(stdout + d.toString(), max)));
    child.stderr?.on("data", (d) => (stderr = cap(stderr + d.toString())));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err), timedOut });
    });
  });
}

function cap(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? s.slice(0, max / 2) + "\n…[tronqué]…\n" + s.slice(-max / 2) : s;
}

export function formatExec(r: ExecResult): string {
  const parts = [`exit=${r.code}${r.timedOut ? " (TIMEOUT)" : ""}`];
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trim()}`);
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trim()}`);
  return redactSecrets(parts.join("\n"));
}

/** Commandes qu'on refuse même dans le sandbox : le coût d'erreur est trop élevé. */
const DENY = [/\brm\s+-rf\s+\/(\s|$)/, /\bmkfs\b/, /\bdd\s+if=/, /:\(\)\s*\{\s*:\|:&\s*\};:/, /\bgit\s+push\s+.*--force\b/, /\bgit\s+push\s+-f\b/];

export function safePath(p: string): string {
  const root = config().SANDBOX_WORKDIR;
  if (!p.startsWith(root + "/") && p !== root) throw new Error(`chemin hors de ${root}`);
  if (p.includes("/../")) throw new Error("chemin interdit");
  return p;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Fabrique les trois outils sandbox liés à UN conteneur. */
export function makeSandboxTools(container?: string) {
  const bash = betaZodTool({
    name: "sandbox_bash",
    description:
      "Exécute une commande bash dans le sandbox isolé (Node 22, Python 3, git, vercel CLI, playwright/chromium). Le répertoire /work persiste entre missions. Sortie tronquée à 40k caractères. Pas de force-push.",
    inputSchema: z.object({
      command: z.string().min(1),
      cwd: z.string().optional().describe("Répertoire de travail, par défaut /work"),
      timeout_seconds: z.number().int().min(1).max(1800).default(300),
    }),
    run: async (i) => {
      if (DENY.some((re) => re.test(i.command))) return "Error: commande interdite par la politique de sécurité";
      logger.info({ container, cmd: i.command.slice(0, 200) }, "sandbox_bash");
      const r = await sandboxExec(i.command, { cwd: i.cwd, timeoutMs: i.timeout_seconds * 1000, container });
      return formatExec(r);
    },
  });

  const readFile = betaZodTool({
    name: "sandbox_read_file",
    description: "Lit un fichier texte dans le sandbox (chemin absolu sous /work). Optionnellement une plage de lignes.",
    inputSchema: z.object({
      path: z.string(),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    }),
    run: async (i) => {
      const p = safePath(i.path);
      const range = i.start_line || i.end_line ? `sed -n '${i.start_line ?? 1},${i.end_line ?? "$"}p'` : "cat";
      const r = await sandboxExec(`${range} ${shellQuote(p)}`, { timeoutMs: 30_000, container });
      return formatExec(r);
    },
  });

  const writeFile = betaZodTool({
    name: "sandbox_write_file",
    description: "Écrit (ou remplace) un fichier texte dans le sandbox (chemin absolu sous /work). Crée les répertoires parents.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    run: async (i) => {
      const p = safePath(i.path);
      const b64 = Buffer.from(i.content, "utf8").toString("base64");
      const r = await sandboxExec(
        `mkdir -p "$(dirname ${shellQuote(p)})" && echo ${shellQuote(b64)} | base64 -d > ${shellQuote(p)} && wc -c < ${shellQuote(p)}`,
        { timeoutMs: 30_000, container },
      );
      return r.code === 0 ? `écrit ${p} (${r.stdout.trim()} octets)` : formatExec(r);
    },
  });

  return { bash, readFile, writeFile, all: [bash, readFile, writeFile] };
}

const defaults = makeSandboxTools();
export const bashTool = defaults.bash;
export const readFileTool = defaults.readFile;
export const writeFileTool = defaults.writeFile;
