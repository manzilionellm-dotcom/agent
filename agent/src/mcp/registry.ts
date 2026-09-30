import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mcpTools, type MCPClientLike, type MCPCallToolResultLike } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { z } from "zod";
import { config } from "../config.js";
import type { AnyRunnableTool } from "../llm.js";
import { logger } from "../logger.js";
import { untrusted } from "../safety.js";
import { requestApproval } from "../channels/approvals.js";

/**
 * Registre MCP : chaque serveur (GitHub, Gmail, Google Calendar, Vercel, …)
 * est décrit dans mcp.json, connecté au boot, et ses outils sont exposés au
 * modèle avec un préfixe `<serveur>__` pour éviter les collisions.
 *
 * Deux garde-fous que la plupart des tutoriels oublient :
 *   - allowlist par serveur : on n'expose PAS les 80 outils du serveur GitHub,
 *     seulement ceux dont la mission a besoin (contexte + sécurité + cache).
 *   - gating : les outils listés dans `confirm` sont exécutés en « dry-run »
 *     (retour explicatif) sauf si la mission a le drapeau `allowIrreversible`.
 */

const ServerSchema = z.object({
  transport: z.enum(["stdio", "http"]).default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  /** Variables d'env à transmettre : valeurs littérales ou `${VAR}` résolues depuis process.env. */
  env: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  allow: z.array(z.string()).default([]),
  confirm: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const FileSchema = z.object({ servers: z.record(z.string(), ServerSchema) });

export type McpServerConfig = z.infer<typeof ServerSchema>;

type Connected = { name: string; client: Client; cfg: McpServerConfig; tools: AnyRunnableTool[] };

const connected = new Map<string, Connected>();

function resolveEnv(v: string): string {
  return v.replace(/\$\{(\w+)\}/g, (_, k: string) => process.env[k] ?? "");
}

export async function connectMcpServers(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(config().MCP_CONFIG_PATH, "utf8");
  } catch {
    logger.warn({ path: config().MCP_CONFIG_PATH }, "mcp.json absent — aucun serveur MCP");
    return;
  }
  const file = FileSchema.parse(JSON.parse(raw));

  await Promise.all(
    Object.entries(file.servers).map(async ([name, cfg]) => {
      if (!cfg.enabled) return;
      try {
        const client = new Client({ name: `manzi-${name}`, version: "0.1.0" });
        if (cfg.transport === "http") {
          if (!cfg.url) throw new Error("url requis pour transport http");
          const headers = Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, resolveEnv(v)]));
          await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } }));
        } else {
          if (!cfg.command) throw new Error("command requis pour transport stdio");
          const env = { ...process.env, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, resolveEnv(v)])) } as Record<string, string>;
          await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env, stderr: "pipe" }));
        }
        const { tools } = await client.listTools();
        const allowed = cfg.allow.length ? tools.filter((t) => cfg.allow.includes(t.name)) : tools;
        // Le SDK MCP type callTool en union (résultat legacy `toolResult`) ; on adapte à l'interface attendue.
        const like: MCPClientLike = { callTool: (p) => client.callTool(p) as Promise<MCPCallToolResultLike> };
        const runnable: AnyRunnableTool[] = mcpTools(allowed, like).map((t) => {
          const original = t.run;
          const full = `${name}__${t.name}`;
          // Les contenus lus via MCP (e-mails, issues, pages) sont des données externes.
          return Object.assign(t, {
            name: full,
            run: async (args: Record<string, unknown>, ctx?: unknown) => {
              const out = await (original as (a: Record<string, unknown>, c?: unknown) => Promise<unknown>)(args, ctx);
              return typeof out === "string" ? untrusted(full, out) : (out as never);
            },
          });
        });
        connected.set(name, { name, client, cfg, tools: runnable });
        logger.info({ server: name, tools: runnable.map((t) => t.name) }, "mcp connecté");
      } catch (err) {
        logger.error({ server: name, err: String(err) }, "mcp connexion échouée — serveur ignoré");
      }
    }),
  );
}

/**
 * Retourne les outils MCP demandés, avec gating des outils irréversibles.
 * `servers` : liste des serveurs à exposer pour cette mission.
 */
export function mcpToolsFor(servers: string[], opts: { allowIrreversible?: boolean } = {}): AnyRunnableTool[] {
  const out: AnyRunnableTool[] = [];
  for (const s of servers) {
    const c = connected.get(s);
    if (!c) continue;
    for (const t of c.tools) {
      const bare = t.name.slice(s.length + 2);
      if (c.cfg.confirm.includes(bare) && !opts.allowIrreversible) {
        // Outil irréversible : approbation par WhatsApp (code à renvoyer) ; sinon dry-run.
        const original = t.run;
        const gated = Object.assign({}, t, {
          run: async (args: Record<string, unknown>, ctx?: unknown) => {
            const decision = await requestApproval(t.name, args);
            if (decision === "approved") return (original as (a: Record<string, unknown>, c?: unknown) => Promise<unknown>)(args, ctx) as never;
            if (decision === "denied") return "REFUSÉ par l'opérateur. N'insiste pas ; note-le dans le rapport.";
            return `EN ATTENTE / DRY-RUN (outil irréversible, pas d'approbation reçue). Appel prévu: ${t.name}(${JSON.stringify(args).slice(0, 1500)}). Décris cette action dans le rapport pour validation humaine.`;
          },
        }) as AnyRunnableTool;
        out.push(gated);
      } else {
        out.push(t);
      }
    }
  }
  return out;
}

export function mcpStatus(): Record<string, string[]> {
  return Object.fromEntries([...connected.values()].map((c) => [c.name, c.tools.map((t) => t.name)]));
}

export async function disconnectMcpServers(): Promise<void> {
  await Promise.allSettled([...connected.values()].map((c) => c.client.close()));
  connected.clear();
}
