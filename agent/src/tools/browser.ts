import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sandboxExec, shellQuote } from "./sandbox.js";
import { untrusted } from "../safety.js";

/**
 * Navigateur complet, piloté pas à pas (comme « Claude dans Chrome ») :
 *   - BROWSER_CDP_URL défini → TON Chrome, avec toutes tes sessions (via tunnel SSH) ;
 *   - sinon → Chromium persistant dans le sandbox (connexions conservées entre missions).
 * L'état (onglets, page courante) persiste entre les appels d'une même mission grâce au
 * démon (docker/browser/daemon.js). Les captures reviennent en image quand le modèle
 * les accepte (Claude), en fichier sinon.
 *
 * RISQUE (une ligne) : en mode CDP, l'agent agit dans tes comptes connectés ; garde
 * le mode manuel et donne des ordres précis.
 */

const Action = z.enum(["goto", "text", "html", "click", "type", "press", "scroll", "screenshot", "links", "eval", "wait", "tabs", "back", "cookies", "status"]);

export function makeBrowserTool(container?: string) {
  return betaZodTool({
    name: "browser",
    description:
      "Navigateur réel persistant (Chrome). Actions : goto{url} · text{max_chars} (contenu lisible, arbre d'accessibilité) · click{selector|text|role+name|label} · type{selector|label|placeholder, value, enter?} · press{key} · scroll{dy} · screenshot{full?} · links{max} · eval{js} · wait{selector|ms} · tabs{op:list|new|switch|close, index?, url?} · back · cookies{url} · status. Un appel = une action ; lis le résultat avant la suivante. Ne saisis jamais un mot de passe que l'opérateur n'a pas fourni dans la mission.",
    inputSchema: z.object({
      action: Action,
      url: z.string().url().optional(),
      selector: z.string().optional(),
      text: z.string().optional().describe("Texte visible à cliquer (click) "),
      role: z.string().optional(),
      name: z.string().optional(),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      exact: z.boolean().optional(),
      value: z.string().optional().describe("Texte à saisir (type)"),
      enter: z.boolean().optional(),
      clear: z.boolean().optional(),
      key: z.string().optional().describe("Touche pour press, ex: Enter, Escape, PageDown"),
      dy: z.number().optional(),
      full: z.boolean().optional(),
      max: z.number().int().optional(),
      max_chars: z.number().int().min(500).max(60_000).optional(),
      js: z.string().optional(),
      ms: z.number().int().optional(),
      timeout_ms: z.number().int().optional(),
      op: z.enum(["list", "new", "switch", "close"]).optional(),
      index: z.number().int().optional(),
      wait: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      settle_ms: z.number().int().optional(),
    }),
    run: async (i) => {
      const { action, ...args } = i;
      const cfg = config();
      const target = i.url ?? (action === "tabs" && i.op === "new" ? i.url : undefined);
      if (target && isDenied(target)) return `Error: domaine interdit par BROWSER_DENY_DOMAINS (${new URL(target).hostname})`;
      logger.info({ container, action, url: i.url, selector: i.selector, text: i.text }, "browser");
      const r = await sandboxExec(`node /opt/browser/bctl.js ${shellQuote(action)} ${shellQuote(JSON.stringify(args))}`, {
        timeoutMs: 150_000,
        container,
        env: cfg.BROWSER_CDP_URL ? { BROWSER_CDP_URL: cfg.BROWSER_CDP_URL } : {},
      });
      let out: { ok?: boolean; error?: string; base64?: string; file?: string } & Record<string, unknown>;
      try {
        out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}");
      } catch {
        return `Error: réponse navigateur illisible\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-800)}`;
      }
      if (!out.ok) return `Error: ${out.error ?? "échec"}`;
      if (action === "screenshot" && out.base64) {
        const img: Anthropic.Beta.Messages.BetaImageBlockParam = { type: "image", source: { type: "base64", media_type: "image/png", data: out.base64 } };
        const provider = cfg.LLM_PROVIDER_CRITICAL === "anthropic" || cfg.LLM_PROVIDER === "anthropic";
        return provider ? [{ type: "text", text: `capture ${out.file}` }, img] : `capture enregistrée : ${out.file} (le modèle courant n'accepte pas les images ; utilise text/links)`;
      }
      delete out.base64;
      const body = JSON.stringify(out, null, 1).slice(0, 30_000);
      return ["goto", "text", "html", "click", "links", "eval"].includes(action) ? untrusted(String(out.url ?? i.url ?? "navigateur"), body) : body;
    },
  });
}

export const browserTool = makeBrowserTool();

/** Domaines où l'agent n'a rien à faire (banque, paiement, admin de comptes). Liste dans .env, wildcard par suffixe. */
function isDenied(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return config()
    .BROWSER_DENY_DOMAINS.split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .some((d) => host === d || host.endsWith("." + d));
}
