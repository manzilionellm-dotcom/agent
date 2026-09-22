import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { untrusted } from "../safety.js";
import { runBctl, isDenied } from "./browser.js";
import { describeSite, findSite, SITES, sitesByKind, type SiteKind } from "../browsing/sites.js";
import { findCredentialSite, vaultEnabled } from "../vault.js";

/**
 * Recherche sur les places de marché et les annuaires d'entreprises.
 *
 * Pourquoi un outil séparé du navigateur générique : une page de résultats
 * de Blocket ou de 1688 fait deux cent mille caractères dont dix-neuf
 * vingtièmes sont du menu, du pied de page et des recommandations. La
 * passer telle quelle au modèle coûte cher et noie les dix lignes qui
 * comptent. Ici on rend des annonces : titre, prix, lien.
 *
 * Et surtout : l'URL de recherche de chaque site a une forme précise que le
 * modèle devinerait mal. Le registre la connaît (browsing/sites.ts).
 */

export const sitesListTool = betaZodTool({
  name: "sites_list",
  description:
    "Liste les sites que tu sais fouiller : places de marché (Blocket, Tradera, Vinted, Fyndiq, Amazon), grossistes (1688, Alibaba, AliExpress, Temu), annuaires d'entreprises (Allabolag, Hitta, Eniro, Google Maps) et sites d'emploi (Platsbanken, Indeed, LinkedIn). Donne pour chacun la langue à utiliser et ses limites. Appelle-le avant site_search si tu hésites sur le site à viser.",
  inputSchema: z.object({
    kind: z.enum(["marketplace", "wholesale", "directory", "jobs"]).optional().describe("Filtre par type de site"),
  }),
  run: async (i) => {
    const list = sitesByKind(i.kind as SiteKind | undefined);
    const vault = vaultEnabled() ? "" : "\n\n(Coffre désactivé : tu ne peux pas te connecter aux sites qui l'exigent.)";
    return `${list.length} sites :\n${list.map((s) => "  " + describeSite(s)).join("\n")}${vault}`;
  },
});

export const siteSearchTool = betaZodTool({
  name: "site_search",
  description:
    "Cherche sur une place de marché, un annuaire d'entreprises ou un site d'emploi, et rend les annonces trouvées (titre, prix, lien). Sites connus : blocket.se, tradera.se, vinted.se, fyndiq.se, sellpy.se, amazon.se, 1688.com, alibaba.com, aliexpress.com, temu.com, allabolag.se, hitta.se, eniro.se, ratsit.se, google.com (Maps), arbetsformedlingen.se, indeed.com, linkedin.com — utilise sites_list pour le détail. " +
    "IMPORTANT : écris la requête dans la langue du site. Pour 1688.com, traduis-la toi-même en chinois (« chaussures homme » → « 男鞋 ») sinon tu n'auras aucun résultat ; pour les sites suédois, écris en suédois. Si le site exige une session, connecte-toi d'abord avec browser{action:'login', site:'…'}.",
  inputSchema: z.object({
    site: z.string().describe("Site à fouiller, ex: blocket.se, 1688.com, allabolag.se"),
    query: z.string().min(1).describe("Requête, DANS LA LANGUE DU SITE"),
    max: z.number().int().min(1).max(60).default(25),
  }),
  run: async (i) => {
    const site = findSite(i.site);
    if (!site) {
      return `Error: site « ${i.site} » inconnu du registre. Les sites disponibles : ${SITES.map((s) => s.host).join(", ")}. Pour un site hors registre, utilise browser{action:"goto"} puis browser{action:"text"}.`;
    }
    const url = site.search(i.query);
    if (isDenied(url)) return `Error: domaine interdit par BROWSER_DENY_DOMAINS (${site.host})`;

    // Prévenir AVANT la recherche, pas après : sur un site qui exige une
    // session, la page de résultats existe, elle est simplement vide — et
    // une page vide se lit comme « aucun produit » au lieu de « connecte-toi ».
    const notes: string[] = [];
    if (site.caveat) notes.push(site.caveat);
    if (site.login !== "never") {
      const known = vaultEnabled() ? await findCredentialSite(site.host).catch(() => undefined) : undefined;
      notes.push(
        site.login === "always"
          ? known
            ? `Ce site exige une session : si les résultats sont vides, appelle browser{action:"login", site:"${site.host}"} puis recommence.`
            : `Ce site exige une session et aucun identifiant n'est au coffre pour ${site.host} : dis à l'opérateur de l'ajouter sur la page /vault de son serveur.`
          : `La liste est publique, le détail demande parfois un compte${known ? ` (identifiant disponible : browser{action:"login", site:"${site.host}"})` : ""}.`,
      );
    }
    if (site.lang === "zh" && !/[一-鿿]/.test(i.query)) {
      notes.push("La requête n'est pas en chinois : traduis-la et relance, sinon les résultats seront vides ou hors sujet.");
    }

    logger.info({ site: site.host, query: i.query.slice(0, 80) }, "site_search");
    const cfg = config();
    const out = await runBctl("listings", JSON.stringify({ url, selectors: site.items, max: i.max, scrolls: 2 }), undefined, cfg.BROWSER_CDP_URL);
    if (typeof out === "string") return out;
    if (!out.ok) return `Error: ${String(out.error ?? "échec")}\n${notes.join("\n")}`;

    const ads = (out.annonces as { titre: string; url: string; prix: string }[]) ?? [];
    const head = `${site.name} — « ${i.query} » — ${ads.length} annonce(s)` + (out.methode === "generique" ? " [extraction générique]" : out.methode === "aucune" ? " [aucune annonce reconnue]" : "");
    const body = ads.length
      ? ads.map((a, n) => `${n + 1}. ${a.titre}${a.prix ? ` — ${a.prix}` : ""}\n   ${a.url}`).join("\n")
      : `Page : ${String(out.titre ?? "")}\n${String(out.apercu ?? "").slice(0, 600)}`;

    return untrusted(site.host, [head, body, notes.length ? "\n— À savoir —\n" + notes.join("\n") : ""].filter(Boolean).join("\n\n"));
  },
});

export const marketTools = [sitesListTool, siteSearchTool];
