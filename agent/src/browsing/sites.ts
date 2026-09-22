/**
 * Registre des sites que l'agent sait ouvrir, fouiller et — quand il y a un
 * identifiant au coffre — où il sait se connecter.
 *
 * Pourquoi un registre plutôt que « le modèle se débrouille » : une place de
 * marché n'est pas une page web ordinaire. L'URL de recherche a une forme
 * précise, la connexion se fait en deux temps, la moitié des sites exigent
 * une session avant d'afficher un prix, et deux d'entre eux collent un
 * captcha à la première saisie automatisée. Laisser le modèle redécouvrir
 * ça à chaque fois coûte dix appels et se trompe une fois sur trois.
 *
 * Chaque entrée dit aussi ce qui NE marchera pas. Un registre qui promet
 * tout est un registre qui ment une fois par semaine.
 */

export type SiteKind = "marketplace" | "wholesale" | "directory" | "jobs";

export type SiteProfile = {
  host: string;
  name: string;
  kind: SiteKind;
  /** Pays visé, pour trier ce qui est pertinent à Uppsala de ce qui ne l'est pas. */
  country: string;
  /** Langue attendue dans la requête. « zh » veut dire : traduis avant de chercher, sinon zéro résultat. */
  lang: string;
  /** Construit l'URL de recherche. */
  search: (q: string) => string;
  loginUrl?: string;
  /** never : tout est public · details : la liste est publique, le détail non · always : rien sans session. */
  login: "never" | "details" | "always";
  /** Sélecteurs de résultats, quand ils sont stables. Sinon l'extracteur générique prend le relais. */
  items?: { item: string; title?: string; price?: string; link?: string };
  /** Indices de connexion, quand le formulaire n'est pas devinable. */
  hints?: { ident?: string[]; password?: string[]; submit?: string[]; twoStep?: boolean };
  /** Ce qui coince. Remonté au modèle ET à l'opérateur : une limite tue est une limite qu'on réapprend en production. */
  caveat?: string;
};

const enc = encodeURIComponent;

export const SITES: SiteProfile[] = [
  /* --- Suède : vendre et acheter d'occasion ------------------------------ */
  {
    host: "blocket.se",
    name: "Blocket",
    kind: "marketplace",
    country: "SE",
    lang: "sv",
    login: "never",
    loginUrl: "https://www.blocket.se/logga-in",
    search: (q) => `https://www.blocket.se/annonser/hela_sverige?q=${enc(q)}`,
  },
  {
    host: "tradera.se",
    name: "Tradera",
    kind: "marketplace",
    country: "SE",
    lang: "sv",
    login: "never",
    loginUrl: "https://www.tradera.com/login",
    search: (q) => `https://www.tradera.com/search?q=${enc(q)}`,
  },
  {
    host: "vinted.se",
    name: "Vinted",
    kind: "marketplace",
    country: "SE",
    lang: "sv",
    login: "details",
    loginUrl: "https://www.vinted.se/member/signup/select_type?ref_url=%2F",
    search: (q) => `https://www.vinted.se/catalog?search_text=${enc(q)}`,
    caveat:
      "Protégé par Cloudflare : la première visite peut afficher une page de contrôle quelques secondes. Laisse la page se stabiliser (wait 5 s) avant de lire. Le prix affiché exclut la protection acheteur.",
  },
  {
    host: "fyndiq.se",
    name: "Fyndiq",
    kind: "marketplace",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://fyndiq.se/sok/?q=${enc(q)}`,
  },
  {
    host: "sellpy.se",
    name: "Sellpy",
    kind: "marketplace",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://www.sellpy.se/search?q=${enc(q)}`,
  },
  {
    host: "facebook.com",
    name: "Facebook Marketplace",
    kind: "marketplace",
    country: "SE",
    lang: "sv",
    login: "always",
    loginUrl: "https://www.facebook.com/login",
    search: (q) => `https://www.facebook.com/marketplace/uppsala/search?query=${enc(q)}`,
    caveat:
      "Session obligatoire, et Meta interdit la collecte automatisée dans ses conditions : un compte qui parcourt vite se fait limiter puis bloquer. À utiliser à la main, lentement, ou pas du tout.",
  },

  /* --- Chine : sourcing --------------------------------------------------- */
  {
    host: "1688.com",
    name: "1688 (gros, Alibaba Chine)",
    kind: "wholesale",
    country: "CN",
    lang: "zh",
    login: "details",
    loginUrl: "https://login.1688.com/member/signin.htm",
    search: (q) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${enc(q)}`,
    caveat:
      "Écris la requête EN CHINOIS : « chaussures homme » ne donne rien, « 男鞋 » donne tout. Prix en CNY, souvent par lot avec un minimum de commande (起订量). La connexion automatisée déclenche presque toujours un captcha à glissière : passe par une session déjà ouverte (browser session load) plutôt que par login.",
  },
  {
    host: "alibaba.com",
    name: "Alibaba (gros, international)",
    kind: "wholesale",
    country: "CN",
    lang: "en",
    login: "details",
    loginUrl: "https://login.alibaba.com/",
    search: (q) => `https://www.alibaba.com/trade/search?SearchText=${enc(q)}`,
    caveat: "Version anglaise de 1688, prix plus élevés mais fournisseurs habitués à l'export et à l'Europe. Compare toujours les deux avant de commander.",
  },
  {
    host: "aliexpress.com",
    name: "AliExpress (détail)",
    kind: "marketplace",
    country: "CN",
    lang: "en",
    login: "never",
    search: (q) => `https://www.aliexpress.com/w/wholesale-${enc(q.replace(/\s+/g, "-"))}.html`,
  },
  {
    host: "temu.com",
    name: "Temu",
    kind: "marketplace",
    country: "CN",
    lang: "en",
    login: "details",
    search: (q) => `https://www.temu.com/search_result.html?search_key=${enc(q)}`,
    caveat: "Anti-robot agressif : lis la page, ne l'enchaîne pas. Au-delà de quelques recherches d'affilée, la page revient vide.",
  },
  {
    host: "amazon.se",
    name: "Amazon Suède",
    kind: "marketplace",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://www.amazon.se/s?k=${enc(q)}`,
    caveat: "Sert surtout de référence de prix de vente au détail : c'est le prix qu'un client suédois a en tête.",
  },

  /* --- Annuaires d'entreprises : prospecter ------------------------------ */
  {
    host: "allabolag.se",
    name: "Allabolag (registre des sociétés)",
    kind: "directory",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://www.allabolag.se/what/${enc(q)}`,
    caveat: "La source pour vérifier qu'une entreprise existe : numéro d'organisation, chiffre d'affaires, dirigeants, année de création. À faire avant tout démarchage.",
  },
  {
    host: "hitta.se",
    name: "Hitta.se",
    kind: "directory",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://www.hitta.se/s%C3%B6k?vad=${enc(q)}`,
  },
  {
    host: "eniro.se",
    name: "Eniro",
    kind: "directory",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://www.eniro.se/${enc(q)}/f%C3%B6retag`,
  },
  {
    host: "ratsit.se",
    name: "Ratsit",
    kind: "directory",
    country: "SE",
    lang: "sv",
    login: "details",
    search: (q) => `https://www.ratsit.se/sok/foretag?vem=${enc(q)}`,
  },
  {
    host: "google.com",
    name: "Google Maps (commerces locaux)",
    kind: "directory",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://www.google.com/maps/search/${enc(q)}`,
    caveat: "Le meilleur annuaire de commerces réels : horaires, avis, téléphone, et l'adresse exacte pour s'y rendre. Lis la page après 3 s, la carte se remplit en différé.",
  },

  /* --- Travail ------------------------------------------------------------ */
  {
    host: "arbetsformedlingen.se",
    name: "Platsbanken (Arbetsförmedlingen)",
    kind: "jobs",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://arbetsformedlingen.se/platsbanken/annonser?q=${enc(q)}`,
    caveat: "La source officielle suédoise : toute offre publiée légalement y passe. Écris la requête en suédois.",
  },
  {
    host: "indeed.com",
    name: "Indeed Suède",
    kind: "jobs",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://se.indeed.com/jobb?q=${enc(q)}&l=Uppsala`,
  },
  {
    host: "linkedin.com",
    name: "LinkedIn Jobs",
    kind: "jobs",
    country: "SE",
    lang: "en",
    login: "details",
    loginUrl: "https://www.linkedin.com/login",
    search: (q) => `https://www.linkedin.com/jobs/search?keywords=${enc(q)}&location=Sweden`,
    hints: { ident: ["#username", 'input[name="session_key"]'], password: ["#password", 'input[name="session_password"]'], submit: ['button[type="submit"]'] },
    caveat: "Sans session, LinkedIn ne montre que les trois premières offres puis exige une connexion.",
  },
  {
    host: "blocket.jobb.se",
    name: "Blocket Jobb",
    kind: "jobs",
    country: "SE",
    lang: "sv",
    login: "never",
    search: (q) => `https://jobb.blocket.se/lediga-jobb?q=${enc(q)}`,
  },
];

/** Index par hôte, calculé une fois. */
const BY_HOST = new Map(SITES.map((s) => [s.host, s]));

/**
 * Retrouve un site à partir de ce que l'utilisateur ou le modèle a écrit :
 * « vinted », « Vinted.se », « https://www.vinted.se/catalog », « 1688 ».
 */
export function findSite(input: string): SiteProfile | undefined {
  let s = input.trim().toLowerCase();
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      /* ignore */
    }
  }
  s = s.split("/")[0]!.replace(/^www\./, "");
  const exact = BY_HOST.get(s);
  if (exact) return exact;
  const suffix = SITES.find((p) => s.endsWith("." + p.host) || s === p.host.split(".")[0]);
  if (suffix) return suffix;
  // « vinted » → vinted.se ; « amazon » → amazon.se. Seulement sans ambiguïté :
  // deux candidats, c'est une question à poser, pas un site à choisir au hasard.
  const loose = SITES.filter((p) => p.host.split(".")[0] === s || p.name.toLowerCase().includes(s));
  return loose.length === 1 ? loose[0] : undefined;
}

export function sitesByKind(kind?: SiteKind): SiteProfile[] {
  return kind ? SITES.filter((s) => s.kind === kind) : SITES;
}

/** Résumé d'une ligne, destiné au modèle : ce qu'est le site, et ce qui coince. */
export function describeSite(s: SiteProfile): string {
  const login = s.login === "never" ? "sans compte" : s.login === "details" ? "compte utile pour le détail" : "compte obligatoire";
  return `${s.host} — ${s.name} (${s.kind}, ${s.country}, requête en ${s.lang}, ${login})${s.caveat ? `\n    ⚠ ${s.caveat}` : ""}`;
}
