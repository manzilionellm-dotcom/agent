/**
 * SEO + GEO en 2026 : ce qu'une page doit être pour être classée par Google
 * ET citée par les moteurs de réponse (Grok, ChatGPT, Perplexity, AI
 * Overviews). Ces textes sont les « prompts internes » du bot : ils sont
 * injectés dans les missions site_seo_geo et seo_daily, et donnés au codeur
 * comme cahier des charges de chaque page.
 *
 * Ce n'est pas de la théorie : une page qui répond en 150 mots, avec des
 * H2 en forme de question, un FAQPage valide et des entités nommées, est
 * ce qu'un extracteur de réponses découpe le plus facilement. Le reste
 * (sitemap, robots, IndexNow) fait qu'elle est vue en heures, pas en
 * semaines.
 */

export const GABARIT_PAGE_GEO = `GABARIT D'UNE PAGE (obligatoire pour chaque page créée ou réécrite) :
1. RÉPONSE D'ABORD : les 150 premiers mots répondent directement à la question de la page (qui, quoi, combien, quand), sans introduction. Un moteur de réponse ne lit souvent que ça.
2. TITRE : <title> ≤ 60 caractères avec le mot-clé principal en tête ; <meta name="description"> de 120 à 155 caractères, une promesse concrète + une donnée ; un seul <h1>, différent du <title>.
3. STRUCTURE ATOMIQUE : chaque <h2> est une question telle qu'un humain la pose (« Combien coûte… ? », « Est-ce légal en Suède ? »), suivie d'un bloc autonome de 60 à 200 mots qui se comprend seul, sorti de son contexte. Pas de « comme vu plus haut ».
4. DONNÉES ET ENTITÉS : chiffres datés (année, source), noms propres explicites (produit, marque, ville, loi, organisme), unités et devises (kr, €). Au moins un tableau ou une liste comparative quand la question s'y prête. Un exemple concret par section.
5. PAS DE CONTENU MINCE : 800 mots minimum par page, chaque section apporte une information vérifiable ; ce qui ne sert pas au lecteur est supprimé.
6. FAQ : 4 à 8 questions réelles (celles des SERP « autres questions posées » et des conversations X), réponses de 40 à 90 mots, ET le JSON-LD FAQPage correspondant, mot pour mot identique au texte visible.
7. JSON-LD : Article (headline, datePublished, dateModified, author avec name et url, publisher) ; Product/Offer ou Service quand il y a un prix ; BreadcrumbList. Valide (JSON.parse doit passer), un seul bloc par type.
8. HTML SÉMANTIQUE, RESPONSIVE : <main>, <article>, <section>, <nav>, <footer> ; meta viewport ; images en webp/avif avec alt descriptif, largeur et hauteur déclarées, loading="lazy" sous la ligne de flottaison ; aucune police ou script inutile ; tout tient dans une seule requête HTML + une feuille de style.
9. LIENS : 2 à 4 liens internes vers des pages existantes (texte d'ancre = sujet de la cible), 1 à 3 sources externes fiables citées en clair.
10. CTA : un appel à l'action visible avant la ligne de flottaison et un en fin de page, verbe d'action + bénéfice, jamais « cliquez ici ».
11. SIGNAUX DE CONFIANCE : auteur identifié, date de mise à jour visible, mentions légales et contact accessibles depuis chaque page, méthodologie en une phrase quand il y a un classement ou un comparatif.
12. LANGUE : la langue du marché visé (suédois pour la Suède, sans mélange) ; hreflang si le site a plusieurs langues ; canonical absolu sur chaque page.`;

export const ROBOTS_IA = `INDEXATION ET ACCÈS DES IA :
- robots.txt : autorise tout par défaut (« User-agent: * » / « Allow: / »), déclare « Sitemap: https://<domaine>/sitemap.xml ». Ne bloque aucun des robots d'IA : GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, ClaudeBot, Claude-SearchBot, Google-Extended, Applebot-Extended, Amazonbot, Bingbot ; pour Grok, les noms rapportés sont GrokBot, xAI-Grok, Grok-DeepSearch et xAI-Bot (non documentés officiellement par xAI ; Grok se présente souvent comme un navigateur ordinaire, donc ne bloque rien qui ressemble à un navigateur).
- sitemap.xml : toutes les pages indexables, <lastmod> exact (date du dernier vrai changement), généré à chaque build, pas de page en noindex dedans.
- llms.txt à la racine : titre du site, une phrase par page clé avec son URL, mise à jour à chaque publication.
- IndexNow : le fichier de clé /<clé>.txt à la racine (la clé est donnée par l'outil indexnow_submit) ; après chaque déploiement, soumets les URL créées ou modifiées avec indexnow_submit. Google n'écoute pas IndexNow : c'est le sitemap qui compte pour lui.
- Chaque page : canonical absolu, pas de paramètre d'URL inutile, 200 en moins d'une seconde, HTML < 150 ko.`;

export const RECHERCHE_MOTS_CLES = `RECHERCHE DE MOTS-CLÉS ET DE QUESTIONS (double source : web indexé + conversations X en direct) :
1. Web : pour le sujet, 5 à 8 requêtes (tavily_search topic general et news, serpapi_search si disponible) dans la langue du marché ; note les titres qui se classent, les « autres questions posées », les mots qui reviennent dans les titres. Dates : ne garde que ce qui a moins de 12 mois quand le sujet bouge.
2. X : x_profile sur 3 à 5 comptes qui parlent du sujet (concurrents, médias spécialisés, communautés), et tavily_search topic news avec le nom du sujet + « X » ou « twitter » : relève les questions que les gens posent EN CE MOMENT, les plaintes, les mots exacts qu'ils emploient. Ce vocabulaire va dans les H2 et la FAQ.
3. Concurrents : lire_code_site sur les 3 à 5 pages qui se classent ; note leurs H2, leur JSON-LD, leurs signaux commerciaux, ce qu'ils n'expliquent pas. Le GAP = les questions posées sur X et dans les SERP que personne ne traite proprement : c'est la matière première des pages.
4. Sortie : une liste de pages à créer (mot-clé principal, 3 à 6 questions H2, entités à nommer, données à sourcer, CTA), classée par intérêt de recherche × faiblesse de la concurrence.`;

export const SUIVI_CITATIONS = `SUIVI DES CITATIONS ET DE L'INDEXATION (quotidien) :
1. Indexation : pour chaque page publiée depuis 14 jours, tavily_search avec l'URL exacte entre guillemets et serpapi_search « site:<domaine> » ; note indexée / pas encore. Une page absente après 7 jours → resoumettre via indexnow_submit et vérifier qu'elle est bien dans le sitemap et sans noindex.
2. Citations : tavily_search (topic news, 7 jours) sur « <marque> », « <domaine> », et sur 3 questions clés du site ; x_profile sur les comptes qui reprennent le sujet ; relève toute page ou tout post qui cite le site ou reprend ses chiffres.
3. Positions : pour 5 requêtes cibles, serpapi_search (si disponible) et note la position ; sinon, tavily_search et note si le site apparaît dans les 8 premiers.
4. Ajustements : pour chaque page qui n'apparaît pas, une action concrète (réponse directe plus nette dans les 150 premiers mots, H2 reformulé en question réelle, donnée datée ajoutée, FAQ enrichie, lien interne manquant), consignée dans /memories/seo/ajustements.md ; les 2 plus rentables sont déléguées au codeur et publiées.
5. Journal : /memories/seo/citations.md (date, page, indexée, citée par, position), et un bilan de 8 lignes envoyé à l'opérateur.`;
