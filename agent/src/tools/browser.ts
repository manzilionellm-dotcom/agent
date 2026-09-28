import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { masquerCles } from "./masque-cles.js";
import { sandboxExec, shellQuote } from "./sandbox.js";
import { untrusted, redactSecrets } from "../safety.js";
import { findCredentialSite, getCredential, listCredentials, touchCredential, totpCode, totpRemaining, vaultEnabled } from "../vault.js";
import { findSite } from "../browsing/sites.js";

/**
 * Navigateur complet, piloté pas à pas (comme « Claude dans Chrome ») :
 *   - BROWSER_CDP_URL défini → TON Chrome, avec toutes tes sessions (via tunnel SSH) ;
 *   - sinon → Chromium persistant dans le sandbox (connexions conservées entre missions).
 *     Avec BROWSER_STEALTH=true (défaut) : patches fingerprint (voir docs/STEALTH.md).
 * L'état (onglets, page courante) persiste entre les appels d'une même mission grâce au
 * démon (docker/browser/daemon.js). Les captures reviennent en image quand le modèle
 * les accepte (Claude), en fichier sinon.
 *
 * RISQUE (une ligne) : en mode CDP, l'agent agit dans tes comptes connectés ; garde
 * le mode manuel et donne des ordres précis.
 */

const Action = z.enum([
  "goto", "text", "html", "click", "type", "press", "scroll", "screenshot", "links", "eval", "wait",
  "tabs", "back", "cookies", "status", "login", "session",
  // Ce qu'il faut pour remplir un vrai formulaire, pas une maquette :
  "select", "check", "upload", "download", "form", "listings",
  // Gmail à l'écran, quand l'API Google n'est pas là.
  "gmail",
]);

/** Env BROWSER_* transmis au sandbox pour le démon (CDP + stealth). */
function browserEnv(): Record<string, string> {
  const cfg = config();
  const env: Record<string, string> = {
    BROWSER_STEALTH: cfg.BROWSER_STEALTH ? "true" : "false",
    BROWSER_LOCALE: cfg.BROWSER_LOCALE,
    BROWSER_TIMEZONE: cfg.BROWSER_TIMEZONE,
  };
  if (cfg.BROWSER_CDP_URL) env.BROWSER_CDP_URL = cfg.BROWSER_CDP_URL;
  return env;
}

export function makeBrowserTool(container?: string) {
  return betaZodTool({
    name: "browser",
    description:
      "Navigateur réel persistant (Chrome). Actions : goto{url} · text{max_chars} (contenu lisible, arbre d'accessibilité) · click{selector|text|role+name|label} · type{selector|label|placeholder, value, enter?} · press{key} · scroll{dy} · screenshot{full?} · links{max} · eval{js} · wait{selector|ms} · tabs{op:list|new|switch|close, index?, url?} · back · cookies{url} · status · " +
      "login{site, compte?} : se connecte au site avec l'identifiant enregistré dans le coffre de l'opérateur (tu ne vois jamais le mot de passe, tu ne le demandes jamais, tu ne le tapes jamais toi-même ; utilise `vault_list` pour savoir quels sites et quels comptes sont disponibles — « perso », « pro » — et passe compte quand Lionel précise lequel) · " +
      "session{op:save|load} : sauvegarde ou restaure les sessions ouvertes · " +
      "form{selector?} : liste les champs d'un formulaire (nom, type, étiquette, options) — appelle-le plutôt que de deviner un sélecteur · " +
      "select{selector|label, value|name|index} : liste déroulante (type ne marche pas sur un <select>) · " +
      "check{selector|label, uncheck?} : case à cocher · " +
      "upload{file | files:[…], selector|label|text ?} : envoie un ou plusieurs fichiers de /work dans un champ de fichier (les photos reçues sur WhatsApp sont dans /work/whatsapp/) ; sans cible, le premier champ fichier de la page ; la cible peut aussi être le bouton « Ajouter des photos » · " +
      "download{url} : récupère directement un fichier ou une IMAGE par son adresse (photo d'annonce : trouve son src avec eval) ; download{selector|text} : clique un lien de téléchargement (facture PDF, export) ; le fichier va dans /work/downloads · " +
      "gmail{op:inbox|search|read, query?, index?, max?} : la boîte Gmail de l'opérateur, telle qu'elle est ouverte dans ce navigateur — inbox liste les derniers messages, search cherche (« from:ionos », « is:unread »), read{index} ouvre le n-ième de la liste et rend son texte. C'est le chemin des e-mails quand les outils gmail_* sont absents ou en panne. " +
      "Les cibles sont cherchées aussi dans les iframes, et un clic qui ouvre un onglet le suit tout seul. " +
      "Un appel = une action ; lis le résultat avant la suivante. Ne saisis JAMAIS un mot de passe avec `type` — si un site en demande un, utilise `login`.",
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
      site: z.string().optional().describe("Site du coffre pour l'action login, ex: linkedin.com, blocket.se"),
      compte: z.string().optional().describe("login : quel compte du site quand il y en a plusieurs (« perso », « pro », ou l'e-mail) — vault_list les liste"),
      op: z.enum(["list", "new", "switch", "close", "save", "load", "inbox", "search", "read"]).optional(),
      query: z.string().optional().describe("gmail search : requête Gmail (from:, subject:, is:unread, newer_than:2d)"),
      file: z.string().optional().describe("Chemin absolu sous /work, pour upload"),
      files: z.array(z.string()).optional(),
      uncheck: z.boolean().optional().describe("check : décocher au lieu de cocher"),
      scrolls: z.number().int().min(0).max(10).optional(),
      index: z.number().int().optional(),
      wait: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      settle_ms: z.number().int().optional(),
    }),
    run: async (i) => {
      const { action, ...args } = i;
      const cfg = config();
      const target = i.url ?? (action === "tabs" && i.op === "new" ? i.url : undefined);
      if (target && isDenied(target)) return `Error: domaine interdit par BROWSER_DENY_DOMAINS (${new URL(target).hostname})`;

      if (action === "login") {
        const asked = i.site ?? i.url;
        if (!asked) return "Error: précise le site, ex: {action:'login', site:'linkedin.com'}";
        if (!vaultEnabled()) return "Error: coffre désactivé (VAULT_KEY absente du .env). L'opérateur doit l'activer avant que tu puisses te connecter où que ce soit.";
        const site = await findCredentialSite(asked);
        if (!site) return `Error: aucun identifiant enregistré pour « ${asked} ». Dis à l'opérateur d'aller l'ajouter sur la page /vault de son serveur — il ne doit surtout pas te l'écrire dans la conversation.`;
        if (isDenied(`https://${site}/`)) return `Error: domaine interdit par BROWSER_DENY_DOMAINS (${site})`;
        let cred;
        try {
          cred = await getCredential(site, i.compte);
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)} — passe compte:"perso" ou compte:"pro" (vault_list donne les noms).`;
        }
        if (!cred) return `Error: identifiant « ${site} »${i.compte ? ` compte « ${i.compte} »` : ""} introuvable (vault_list donne les comptes disponibles)`;

        let totp: string | undefined;
        if (cred.totp) {
          if (totpRemaining() < 12) await new Promise((r) => setTimeout(r, (totpRemaining() + 1) * 1000));
          totp = totpCode(cred.totp);
        }
        logger.info({ container, site, totp: Boolean(totp) }, "browser login");
        const profile = findSite(site);
        const payload = JSON.stringify({ url: i.url ?? profile?.loginUrl ?? cred.url, login: cred.login, secret: cred.secret, totp, hints: profile?.hints });
        const out = await runBctl("login", payload, container, cfg.BROWSER_CDP_URL, true);
        if (typeof out === "string") return out;
        if (!out.ok) return `Error: ${String(out.error ?? "échec de connexion")}`;
        if (out.signed_in) await touchCredential(site, cred.compte);
        delete out.base64;
        return redactSecrets(JSON.stringify({ site, compte: cred.compte || "défaut", identifiant: cred.login, ...out }, null, 1).slice(0, 8_000));
      }

      logger.info({ container, action, url: i.url, selector: i.selector, text: i.text }, "browser");
      const r = await sandboxExec(`node /opt/browser/bctl.js ${shellQuote(action)} ${shellQuote(JSON.stringify(args))}`, {
        timeoutMs: 150_000,
        container,
        env: browserEnv(),
      });
      let out: { ok?: boolean; error?: string; base64?: string; file?: string } & Record<string, unknown>;
      try {
        out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}");
      } catch {
        return masquerCles(`Error: réponse navigateur illisible\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-800)}`);
      }
      if (!out.ok) return `Error: ${out.error ?? "échec"}`;
      if (action === "screenshot" && out.file) {
        lastShot.set(container ?? "", String(out.file));
        const voit = cfg.LLM_PROVIDER_CRITICAL === "anthropic" || cfg.LLM_PROVIDER === "anthropic";
        let data = out.base64;
        if (voit && !data) {
          const lu = await sandboxExec(`base64 -w0 ${shellQuote(String(out.file))}`, { timeoutMs: 30_000, container, maxOutput: 12_000_000 });
          data = lu.code === 0 ? lu.stdout.trim() : undefined;
        }
        const img: Anthropic.Beta.Messages.BetaImageBlockParam | undefined = data ? { type: "image", source: { type: "base64", media_type: "image/png", data } } : undefined;
        const suite = `capture prise : ${out.file}. Envoie-la à Lionel avec send_screenshot pour qu'il la voie.`;
        return voit && img ? [{ type: "text", text: suite }, img] : `${suite} (tu ne peux pas la regarder toi-même avec ce modèle ; pour LIRE la page, utilise text ou links)`;
      }
      delete out.base64;
      const body = masquerCles(JSON.stringify(out, null, 1)).slice(0, 30_000);
      return ["goto", "text", "html", "click", "links", "eval"].includes(action) ? untrusted(String(out.url ?? i.url ?? "navigateur"), body) : body;
    },
  });
}

export const browserTool = makeBrowserTool();

const lastShot = new Map<string, string>();

export function lastScreenshot(container?: string): string | undefined {
  return lastShot.get(container ?? "");
}

type BctlOut = { ok?: boolean; error?: string; base64?: string; file?: string } & Record<string, unknown>;

export async function runBctl(action: string, payload: string, container: string | undefined, cdp: string | undefined, viaStdin = false): Promise<BctlOut | string> {
  const env = browserEnv();
  if (cdp) env.BROWSER_CDP_URL = cdp;
  const r = await sandboxExec(`node /opt/browser/bctl.js ${shellQuote(action)} ${viaStdin ? "-" : shellQuote(payload)}`, {
    timeoutMs: 150_000,
    container,
    env,
    stdin: viaStdin ? payload : undefined,
  });
  try {
    return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as BctlOut;
  } catch {
    return `Error: réponse navigateur illisible\n${redactSecrets(r.stdout.slice(-800))}`;
  }
}

export const vaultListTool = betaZodTool({
  name: "vault_list",
  description:
    "Liste les sites où l'opérateur a enregistré un identifiant, avec le compte utilisé. Sert à savoir où tu peux te connecter seul avec browser{action:'login', site:'…'}. Ne renvoie aucun mot de passe et il n'existe aucun moyen d'en obtenir un : si un site manque, dis à l'opérateur de l'ajouter sur la page /vault de son serveur, jamais dans la conversation.",
  inputSchema: z.object({}),
  run: async () => {
    if (!vaultEnabled()) return "Coffre désactivé : VAULT_KEY n'est pas définie dans le .env du serveur.";
    const rows = await listCredentials();
    if (!rows.length) return "Coffre vide. L'opérateur ajoute un site sur la page /vault de son serveur.";
    return rows
      .map((c) => `${c.site}${c.compte ? ` [compte « ${c.compte} »]` : ""} — identifiant ${c.login}${c.has_totp ? " (double authentification gérée)" : ""}${c.note ? ` — ${c.note}` : ""}${c.last_used_at ? ` — dernier usage ${c.last_used_at}` : " — jamais utilisé"}`)
      .join("\n");
  },
});

export function isDenied(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return config()
    .BROWSER_DENY_DOMAINS.split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .some((d) => host === d || host.endsWith("." + d));
}
