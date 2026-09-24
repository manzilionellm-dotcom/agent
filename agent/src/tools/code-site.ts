import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { untrusted } from "../safety.js";

/**
 * « Regarde le code de ce site » — ce qu'un développeur lit en ouvrant les
 * outils de développement d'un site concurrent : la pile technique
 * (framework, CMS, CSS), ce qui est branché (analytics, pixels, chat,
 * paiement), le référencement (balises, données structurées, hreflang), la
 * structure de la page (titres, boutons d'appel à l'action, formulaires), le
 * poids (scripts, feuilles de style, images) et la charte (couleurs, polices).
 *
 * Un seul appel HTTP, pas de navigateur : cinq secondes par site, et une
 * sortie compacte que le modèle peut comparer d'un site à l'autre. Pour les
 * scores Lighthouse, c'est site_audit ; pour une page rendue en JavaScript,
 * scrape_page.
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const MAX_HTML = 3 * 1024 * 1024;

type Detecteur = { nom: string; motif: RegExp };

const PILE: Detecteur[] = [
  { nom: "Next.js", motif: /_next\/static|__NEXT_DATA__|next\/dist/i },
  { nom: "Nuxt", motif: /__NUXT__|\/_nuxt\//i },
  { nom: "React", motif: /react(-dom)?(\.production)?\.min\.js|data-reactroot|__reactContainer/i },
  { nom: "Vue", motif: /vue(\.runtime)?(\.global)?(\.prod)?\.js|data-v-[0-9a-f]{6,}/i },
  { nom: "Angular", motif: /ng-version=|angular(\.min)?\.js/i },
  { nom: "Svelte", motif: /svelte-[0-9a-z]{4,}/i },
  { nom: "Astro", motif: /astro-island|\/_astro\//i },
  { nom: "Gatsby", motif: /___gatsby|gatsby-/i },
  { nom: "WordPress", motif: /wp-content\/|wp-includes\/|wp-json/i },
  { nom: "WooCommerce", motif: /woocommerce/i },
  { nom: "Elementor", motif: /elementor/i },
  { nom: "Shopify", motif: /cdn\.shopify\.com|Shopify\.theme/i },
  { nom: "Wix", motif: /static\.wixstatic\.com|wix-code/i },
  { nom: "Webflow", motif: /webflow\.js|data-wf-page/i },
  { nom: "Squarespace", motif: /squarespace/i },
  { nom: "Framer", motif: /framerusercontent\.com/i },
  { nom: "Bootstrap", motif: /bootstrap(\.min)?\.(css|js)/i },
  { nom: "Tailwind", motif: /tailwindcss|class="[^"]*\b(?:flex|grid|px-\d|py-\d|text-\w+-\d{3})\b[^"]*"/i },
  { nom: "jQuery", motif: /jquery[.-][\d.]*(\.min)?\.js|jquery\.min\.js/i },
  { nom: "Alpine.js", motif: /alpinejs|x-data=/i },
  { nom: "HTMX", motif: /htmx(\.min)?\.js|hx-get=/i },
  { nom: "Vite", motif: /\/@vite\/|vite\/modulepreload/i },
  { nom: "Cloudflare", motif: /cdn-cgi\/|cloudflareinsights|__cf_bm/i },
  { nom: "Vercel", motif: /vercel\.app|vercel-insights|\/_vercel\//i },
  { nom: "Netlify", motif: /netlify/i },
];

const SERVICES: Detecteur[] = [
  { nom: "Google Analytics / GA4", motif: /googletagmanager\.com\/gtag|gtag\('config'|google-analytics\.com/i },
  { nom: "Google Tag Manager", motif: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/i },
  { nom: "Meta Pixel", motif: /connect\.facebook\.net|fbq\('init'/i },
  { nom: "TikTok Pixel", motif: /analytics\.tiktok\.com/i },
  { nom: "Hotjar", motif: /hotjar\.com|hjid/i },
  { nom: "Microsoft Clarity", motif: /clarity\.ms/i },
  { nom: "Plausible", motif: /plausible\.io/i },
  { nom: "Matomo", motif: /matomo|piwik/i },
  { nom: "Google Ads", motif: /googleads|googleadservices|AW-\d{6,}/i },
  { nom: "Google AdSense", motif: /pagead2\.googlesyndication/i },
  { nom: "Stripe", motif: /js\.stripe\.com|stripe\.com\/v3/i },
  { nom: "PayPal", motif: /paypal\.com\/sdk|paypalobjects/i },
  { nom: "Klarna", motif: /klarna/i },
  { nom: "Swish", motif: /\bswish\b/i },
  { nom: "Crypto (paiement)", motif: /coinbase|nowpayments|coinpayments|btcpay|cryptomus/i },
  { nom: "Chat WhatsApp", motif: /wa\.me\/|api\.whatsapp\.com\/send/i },
  { nom: "Telegram", motif: /t\.me\//i },
  { nom: "Tawk.to", motif: /tawk\.to/i },
  { nom: "Crisp", motif: /crisp\.chat/i },
  { nom: "Intercom", motif: /intercom(cdn)?\.com|intercomSettings/i },
  { nom: "Tidio", motif: /tidio/i },
  { nom: "LiveChat", motif: /livechatinc/i },
  { nom: "Zendesk", motif: /zendesk|zopim/i },
  { nom: "Trustpilot", motif: /trustpilot/i },
  { nom: "reCAPTCHA", motif: /recaptcha/i },
  { nom: "hCaptcha", motif: /hcaptcha/i },
  { nom: "Cloudflare Turnstile", motif: /challenges\.cloudflare\.com\/turnstile/i },
  { nom: "Mailchimp", motif: /mailchimp|list-manage\.com/i },
  { nom: "Brevo / Sendinblue", motif: /sendinblue|brevo/i },
  { nom: "Cookie consent", motif: /cookieconsent|cookiebot|onetrust|axeptio|tarteaucitron|didomi/i },
  { nom: "YouTube (vidéo intégrée)", motif: /youtube\.com\/embed|youtube-nocookie/i },
  { nom: "Vimeo", motif: /player\.vimeo\.com/i },
];

const POLICES: Detecteur[] = [
  { nom: "Google Fonts", motif: /fonts\.googleapis\.com|fonts\.gstatic\.com/i },
  { nom: "Adobe Fonts", motif: /use\.typekit\.net/i },
  { nom: "Font Awesome", motif: /font-?awesome/i },
];

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
const strip = (s: string) => decode(clean(s.replace(/<[^>]+>/g, " ")));
const attr = (tag: string, nom: string): string | undefined => {
  const m = tag.match(new RegExp(`\\b${nom}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
};
const all = (html: string, re: RegExp): string[] => [...html.matchAll(re)].map((m) => m[0]);

export type LectureSite = {
  url: string;
  statut: number;
  serveur: string;
  poids_html_ko: number;
  titre: string;
  description: string;
  langue: string;
  canonical: string;
  robots: string;
  hreflang: string[];
  pile: string[];
  services: string[];
  polices: string[];
  donnees_structurees: string[];
  scripts: { total: number; externes: number; hotes: string[] };
  styles: { fichiers: number; inline_ko: number };
  images: { total: number; sans_alt: number; lazy: number; webp_avif: number };
  titres: string[];
  boutons: string[];
  formulaires: Array<{ action: string; champs: number; types: string[] }>;
  liens: { internes: number; externes: number; externes_hotes: string[] };
  couleurs: string[];
  mots: number;
  signaux: string[];
  extrait_texte: string;
};

export async function lireCodeSite(url: string, opts: { fetch?: typeof fetch } = {}): Promise<LectureSite> {
  const f = opts.fetch ?? fetch;
  const res = await f(url, { headers: { "user-agent": UA, accept: "text/html,*/*;q=0.8", "accept-language": "fr,sv;q=0.8,en;q=0.7" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
  const brut = await res.text();
  const html = brut.slice(0, MAX_HTML);
  const u = new URL(res.url || url);
  const host = u.hostname.replace(/^www\./, "");

  const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 200_000);
  const meta = (nom: string) => {
    const tag = all(head, /<meta\b[^>]*>/gi).find((t) => (attr(t, "name") ?? attr(t, "property") ?? "").toLowerCase() === nom);
    return tag ? attr(tag, "content") ?? "" : "";
  };
  const links = all(head, /<link\b[^>]*>/gi);
  const link = (rel: string) => links.filter((t) => (attr(t, "rel") ?? "").toLowerCase().split(/\s+/).includes(rel));

  const scriptsTags = all(html, /<script\b[^>]*>/gi);
  const scriptsSrc = scriptsTags.map((t) => attr(t, "src")).filter((s): s is string => Boolean(s));
  const hote = (s: string) => {
    try {
      return new URL(s, u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const externes = scriptsSrc.map(hote).filter((h) => h && h !== host);
  const compte = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const stylesFichiers = link("stylesheet").length;
  const inlineCss = all(html, /<style\b[^>]*>[\s\S]*?<\/style>/gi).join("\n");
  const cssTotal = inlineCss;
  const couleurs = compte(all(cssTotal + " " + all(html, /style="[^"]*"/gi).join(" "), /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi).map((c) => c.toLowerCase())).slice(0, 8);

  const imgs = all(html, /<img\b[^>]*>/gi);
  const images = {
    total: imgs.length,
    sans_alt: imgs.filter((t) => !attr(t, "alt")).length,
    lazy: imgs.filter((t) => /loading\s*=\s*["']?lazy/i.test(t)).length,
    webp_avif: imgs.filter((t) => /\.(webp|avif)(\?|"|'|\s|$)/i.test(attr(t, "src") ?? "") || /\.(webp|avif)/i.test(attr(t, "srcset") ?? "")).length,
  };

  const titres = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => `H${m[1]} ${strip(m[2]!)}`.slice(0, 120)).filter((t) => t.length > 3).slice(0, 25);
  const boutons = compte(
    [...html.matchAll(/<(?:button|a)\b[^>]*(?:class="[^"]*\b(?:btn|button|cta)\b[^"]*"|role="button")[^>]*>([\s\S]*?)<\/(?:button|a)>/gi)]
      .map((m) => strip(m[1]!).slice(0, 60))
      .filter((t) => t.length > 1 && t.length < 60),
  ).slice(0, 12);

  const formulaires = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)].slice(0, 6).map((m) => {
    const tag = m[0].match(/<form\b[^>]*>/i)![0];
    const inputs = all(m[1]!, /<(?:input|select|textarea)\b[^>]*>/gi);
    return { action: attr(tag, "action") ?? "", champs: inputs.length, types: compte(inputs.map((t) => attr(t, "type") ?? "text")).slice(0, 6) };
  });

  // Interne = même hôte que la page, ou que son canonical : un site servi
  // derrière un autre nom (miroir, préproduction) garde ses liens internes.
  const canonicalHref = link("canonical").map((t) => attr(t, "href") ?? "")[0] ?? "";
  const internes = new Set([host, hote(canonicalHref)].filter(Boolean));
  const hrefs = all(html, /<a\b[^>]*>/gi).map((t) => attr(t, "href") ?? "").filter((h) => /^https?:\/\//i.test(h));
  const externesHotes = hrefs.map(hote).filter((h) => h && !internes.has(h));
  const liens = { internes: hrefs.length - externesHotes.length, externes: externesHotes.length, externes_hotes: compte(externesHotes).slice(0, 10) };

  const jsonld = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => {
    try {
      const j = JSON.parse(m[1]!) as { "@type"?: string | string[]; "@graph"?: Array<{ "@type"?: string }> };
      const t = j["@type"] ?? (j["@graph"] ?? []).map((g) => g["@type"]).filter(Boolean).join("+");
      return Array.isArray(t) ? t.join("+") : String(t || "inconnu");
    } catch {
      return "JSON-LD INVALIDE";
    }
  });

  const corps = strip(html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<head[\s\S]*?<\/head>/i, " "));
  const mots = corps.split(/\s+/).filter(Boolean).length;
  const signaux: string[] = [];
  if (/\b(prix|price|pris|€|kr\b|sek|usd|\$)\b/i.test(corps) && /\b(mois|month|månad|an\b|year|år)\b/i.test(corps)) signaux.push("tarifs affichés (abonnement)");
  if (/\b(essai|trial|test gratuit|free trial|gratis|prova)\b/i.test(corps)) signaux.push("essai gratuit mis en avant");
  if (/\b(garantie?|money.?back|remboursé|refund|återbetalning|pengarna tillbaka)\b/i.test(corps)) signaux.push("garantie / remboursement");
  if (/\b(avis|reviews|témoignages|testimonials|recensioner)\b/i.test(corps)) signaux.push("avis clients");
  if (/\bFAQ\b|questions fréquentes|vanliga frågor/i.test(corps)) signaux.push("FAQ");
  if (/\b(24\/7|24h|support|assistance)\b/i.test(corps)) signaux.push("support mis en avant");
  if (/\b(m3u|xtream|iptv|epg|vod)\b/i.test(corps)) signaux.push("vocabulaire IPTV (m3u, xtream, epg, vod)");
  if (/\b(android tv|fire ?stick|firetv|smart tv|apple tv|mag\b|formuler)\b/i.test(corps)) signaux.push("appareils cités (Android TV, Fire Stick, Smart TV…)");
  if (!/<meta\b[^>]*viewport/i.test(head)) signaux.push("PAS de meta viewport (mobile)");
  if (/<meta\b[^>]*http-equiv\s*=\s*["']refresh/i.test(head)) signaux.push("redirection par meta refresh");

  return {
    url: res.url || url,
    statut: res.status,
    serveur: [res.headers.get("server"), res.headers.get("x-powered-by")].filter(Boolean).join(" · "),
    poids_html_ko: Math.round(brut.length / 1024),
    titre: strip(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    description: meta("description"),
    langue: attr(html.match(/<html\b[^>]*>/i)?.[0] ?? "", "lang") ?? "",
    canonical: canonicalHref,
    robots: meta("robots"),
    hreflang: link("alternate").map((t) => attr(t, "hreflang") ?? "").filter(Boolean),
    pile: PILE.filter((d) => d.motif.test(html)).map((d) => d.nom),
    services: SERVICES.filter((d) => d.motif.test(html)).map((d) => d.nom),
    polices: POLICES.filter((d) => d.motif.test(html)).map((d) => d.nom),
    donnees_structurees: jsonld,
    scripts: { total: scriptsTags.length, externes: externes.length, hotes: compte(externes).slice(0, 12) },
    styles: { fichiers: stylesFichiers, inline_ko: Math.round(inlineCss.length / 1024) },
    images,
    titres,
    boutons,
    formulaires,
    liens,
    couleurs,
    mots,
    signaux,
    extrait_texte: corps.slice(0, 1_200),
  };
}

export const lireCodeSiteTool = betaZodTool({
  name: "lire_code_site",
  description:
    "Lit le code d'un site (concurrent ou le nôtre) comme un développeur qui ouvre les outils de développement : pile technique (framework, CMS, Tailwind…), services branchés (analytics, pixels, chat, paiement, captcha), balises SEO, données structurées, hreflang, scripts et styles (poids, hôtes), images (alt, lazy, webp), structure (titres, boutons d'appel à l'action, formulaires), couleurs de la charte, signaux commerciaux (tarifs, essai, garantie, avis, FAQ). 5 secondes par site, sans navigateur. Pour comparer plusieurs concurrents, appelle-le sur chacun. Scores Lighthouse : site_audit. Page rendue en JavaScript : scrape_page.",
  inputSchema: z.object({ url: z.string().url() }),
  run: async (i) => {
    try {
      const l = await lireCodeSite(i.url);
      return untrusted(i.url, JSON.stringify(l, null, 1).slice(0, 12_000));
    } catch (e) {
      return `Error: ${i.url} illisible — ${String(e).slice(0, 200)}`;
    }
  },
});
