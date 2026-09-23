import { config } from "./config.js";
import { isDenied, runBctl } from "./tools/browser.js";

/**
 * Piloter le navigateur du serveur depuis le panneau.
 *
 * L'écran existait déjà (/screen), mais pour y ouvrir un site il fallait
 * cliquer dans la barre d'adresse d'un Chromium vu à travers noVNC, sur un
 * téléphone — la pire interface possible pour taper une URL. Ici on tape
 * l'adresse dans un vrai champ, le navigateur du bot l'ouvre dans un nouvel
 * onglet, et on arrive directement sur l'écran pour se connecter à la main.
 * La session reste sur le serveur : le bot s'en sert ensuite.
 */

/** « vinted.se », « www.x.com/login », « https://… » → une URL complète, ou une erreur lisible. */
export function normaliserUrl(saisie: string): string {
  const brut = saisie.trim();
  if (!brut) throw new Error("adresse vide");
  const avecSchema = /^[a-z][a-z0-9+.-]*:\/\//i.test(brut) ? brut : `https://${brut}`;
  let u: URL;
  try {
    u = new URL(avecSchema);
  } catch {
    throw new Error(`adresse illisible : « ${brut} »`);
  }
  // http(s) seulement : file://, chrome:// ou javascript: ouvriraient les
  // réglages ou le disque du navigateur, pas un site.
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`seuls les sites web s'ouvrent ici (reçu : ${u.protocol})`);
  if (!u.hostname.includes(".")) throw new Error(`« ${u.hostname} » n'est pas un nom de site`);
  return u.toString();
}

/** Le navigateur visible est-il celui qu'on pilote ? Sinon l'onglet s'ouvrirait dans un Chromium sans écran. */
export function ecranBranche(): boolean {
  return Boolean(config().BROWSER_CDP_URL);
}

export type Ouverture = { url: string; titre: string };

export async function ouvrirSurEcran(saisie: string): Promise<Ouverture> {
  const url = normaliserUrl(saisie);
  if (isDenied(url)) throw new Error(`${new URL(url).hostname} est dans la liste des domaines interdits au navigateur (BROWSER_DENY_DOMAINS)`);
  if (!ecranBranche()) throw new Error("le navigateur du bot n'est pas relié à l'écran (BROWSER_CDP_URL vide) : l'onglet s'ouvrirait sans que tu puisses le voir");
  const cdp = config().BROWSER_CDP_URL;

  // Nouvel onglet d'abord : on ne détruit pas la page sur laquelle le bot
  // travaille peut-être en ce moment.
  const nouvel = await runBctl("tabs", JSON.stringify({ op: "new" }), undefined, cdp);
  if (typeof nouvel === "string" || !nouvel.ok) throw new Error(`navigateur injoignable : ${typeof nouvel === "string" ? nouvel.slice(0, 200) : nouvel.error}`);
  const alle = await runBctl("goto", JSON.stringify({ url, max_chars: 200 }), undefined, cdp);
  if (typeof alle === "string" || !alle.ok) {
    // On referme l'onglet qu'on vient d'ouvrir : sinon chaque essai raté
    // laisse une page d'erreur de plus dans le navigateur du bot.
    await runBctl("tabs", JSON.stringify({ op: "close" }), undefined, cdp).catch(() => undefined);
    throw new Error(`le site ne s'est pas ouvert : ${typeof alle === "string" ? alle.slice(0, 200) : alle.error}`);
  }

  // Mettre l'onglet au premier plan : sans ça, l'écran peut montrer l'ancien
  // et on croit que rien ne s'est passé.
  const onglets = (nouvel as { tabs?: unknown[] }).tabs;
  if (Array.isArray(onglets) && onglets.length) {
    await runBctl("tabs", JSON.stringify({ op: "switch", index: onglets.length - 1 }), undefined, cdp).catch(() => undefined);
  }
  return { url: String(alle.url ?? url), titre: String(alle.title ?? "") };
}

/**
 * Les sites où le navigateur du bot a une session (au sens : des cookies).
 * Nettoyés — point initial, « www. » — et dédoublonnés. Des domaines
 * publicitaires apparaîtront aussi : c'est ce que le navigateur porte
 * réellement, pas une liste arrangée.
 */
export async function sitesConnectes(): Promise<string[]> {
  if (!ecranBranche()) throw new Error("le navigateur du bot n'est pas relié à l'écran (BROWSER_CDP_URL vide)");
  const r = await runBctl("cookies", JSON.stringify({}), undefined, config().BROWSER_CDP_URL);
  if (typeof r === "string" || !r.ok) throw new Error(`navigateur injoignable : ${typeof r === "string" ? r.slice(0, 200) : r.error}`);
  const bruts = ((r as { domains?: string[] }).domains ?? []).map((d) => d.replace(/^\./, "").replace(/^www\./, "").toLowerCase());
  return [...new Set(bruts)].filter(Boolean).sort();
}

/**
 * Télécommande de l'écran : les gestes impossibles au doigt à travers noVNC
 * (défiler, zoomer, taper dans une case, Tab, Entrée), en boutons.
 *
 * Le texte à écrire part par l'entrée standard, jamais en argument : ce peut
 * être un mot de passe, et un argument se lit dans `ps` depuis le sandbox.
 */
export const COMMANDES_ECRAN = ["haut", "bas", "zoom_moins", "zoom_plus", "zoom_normal", "recharger", "retour", "tab", "maj_tab", "entree", "effacer", "echap", "ecrire", "copier"] as const;
export type CommandeEcran = (typeof COMMANDES_ECRAN)[number];

export function estCommandeEcran(op: unknown): op is CommandeEcran {
  return typeof op === "string" && (COMMANDES_ECRAN as readonly string[]).includes(op);
}

export const ECRIRE_MAX = 5000;

export async function telecommande(op: CommandeEcran, texte?: string): Promise<{ url: string; titre: string; zoom: number; texte?: string }> {
  if (!ecranBranche()) throw new Error("le navigateur du bot n'est pas relié à l'écran (BROWSER_CDP_URL vide)");
  if (op === "ecrire" && (!texte || texte.length > ECRIRE_MAX)) throw new Error(`texte vide ou trop long (${ECRIRE_MAX} caractères au plus)`);
  const r = await runBctl("ecran", JSON.stringify({ op, texte: op === "ecrire" ? texte : undefined }), undefined, config().BROWSER_CDP_URL, true);
  if (typeof r === "string" || !r.ok) throw new Error(typeof r === "string" ? "navigateur injoignable" : String(r.error ?? "échec"));
  const o = r as { url?: string; title?: string; zoom?: number; texte?: string };
  return { url: String(o.url ?? ""), titre: String(o.title ?? ""), zoom: Number(o.zoom ?? 1), ...(op === "copier" ? { texte: String(o.texte ?? "") } : {}) };
}
