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

/**
 * Ce que les praticiens du SEO viral et de la vitesse font en 2026, versé
 * par Lionel, trié en trois familles : ce que le bot APPLIQUE, ce qu'il
 * VÉRIFIE (les chiffres sont des ordres de grandeur rapportés, pas des
 * constantes), et ce qu'il N'APPLIQUE PAS parce que Google l'a inscrit dans
 * sa politique anti-spam (abus de domaine expiré, abus de réputation de
 * site, faux signaux) : ces méthodes rapportent un trimestre et coûtent le
 * site. Le bot les connaît pour les reconnaître chez un concurrent et pour
 * les refuser en une ligne, pas pour les employer.
 */
export const SAVOIR_SEO_2026 = `SAVOIR SEO / GEO / VITESSE 2026 (à appliquer par défaut, sans qu'on le demande) :

CE QUI FAIT CITER PAR LES IA ET CLASSER PAR GOOGLE
- Intention exacte avant tout : la page répond à la question complète de l'utilisateur (collection, liste, service, comparatif…), pas à un mot-clé collé. Une page d'intention exacte bat une page longue.
- Réponse directe dans les 200 premiers mots, sous un titre clair ; la valeur dans le premier tiers de la page. Les extracteurs lisent le début, pas l'essai. (Rapporté : plus de la moitié des citations d'AI Overview viennent du premier tiers.)
- Couvre les sous-questions (query fan-out) : Google découpe une requête en sous-recherches ; chaque H2 en traite une. Profondeur = mieux que la concurrence sur le sujet, pas plus de mots.
- Les citations IA viennent en majorité d'URL hors du top 10 Google : on peut être cité sans être classé, à condition d'être extractible (gabarit ci-dessus) et présent hors site.
- Mentions de marque hors site (posts, forums, annuaires, YouTube, X) pèsent plus que les backlinks pour être cité par une IA. Chaque page publiée → 1 mention hors site prévue (post X, fil Reddit détaillé dans le bon subreddit, fiche annuaire), jamais du spam.
- YouTube : une part majeure et croissante des citations IA. Pour un mot-clé commercial, propose un script vidéo de 3 minutes avec la même réponse directe, à publier sur la chaîne du site ; même une petite chaîne prend des requêtes commerciales.
- Outils interactifs (calculatrice, simulateur, générateur, compteur) plutôt que du texte seul : une page-outil attire des clics hors saison et des liens. Quand le sujet s'y prête (prix, économies, dimensions, conversion), code l'outil en HTML+JS inline, résultat visible sans rechargement, et garde le texte explicatif dans le HTML.
- Maillage interne : 3 à 4 liens sortants par page, et les pages importantes reçoivent des dizaines de liens internes avec des ancres visibles (rapporté : 40+ liens entrants internes multiplient le trafic d'une page). Aucune page orpheline : rel=next seul ne compte pas.
- Pagination : noindex sur les pages profondes ; les hubs lient directement aux produits/pages finales.
- Titres et méta descriptions uniques par page ; E-E-A-T : auteur nommé, expérience réelle, sources, surtout sur la santé, l'argent, le droit (YMYL).
- Backlinks : qualité, pas quantité ; un lien d'un site pertinent vaut cent annuaires.
- Entités et JSON-LD : Article, FAQPage, HowTo, Product/Offer, Service, BreadcrumbList — pour que la machine comprenne sans deviner.
- Contenu rendu côté serveur : tout ce qui n'est pas dans le HTML brut est invisible pour les robots IA. Jamais de contenu JavaScript-only.
- llms.txt : deux secondes à faire, aucun miracle à attendre.
- Cadence : publier ou mettre à jour chaque semaine gagne des positions ; moins d'une fois par mois en perd. Mais METTRE À JOUR avant d'écrire du neuf : les pages en position 4 à 20 sont les gains les plus faciles, et 20 % des pages font 70 % du trafic — élargis les gagnantes.
- Dates de mise à jour VRAIES : dateModified change quand le contenu change réellement, avec un vrai ajout. Une fausse fraîcheur est un faux signal et se retourne contre le site.
- Pages « X contre Y » (comparatif honnête avec un concurrent) et pages de réponse directe : elles interceptent l'intention commerciale. Toujours signées par le site, jamais déguisées en avis tiers.
- Programmatic SEO : seulement avec au moins 10 attributs vraiment uniques par page (données, prix, lieux, spécificités) ; les gabarits minces ont perdu la moitié de leur trafic.
- Plusieurs petits sites sur un même sujet, angles différents : possible, mais chaque site doit avoir une identité et un contenu propres ; les impressions de la Search Console disent quelles requêtes creuser ensuite.
- Un seul agent avec mémoire (questions des clients, ton, exemples) bat dix outils séparés : consigne /memories/seo/ (vocabulaire du marché, questions relevées, ce qui a marché) et relis-le avant d'écrire.
- L'UI qui répond instantanément à l'intention est le vrai levier : le texte est bon marché, l'interaction ne l'est pas.

VITESSE (Core Web Vitals : LCP < 2,5 s, INP < 200 ms, CLS < 0,1 ; mobile d'abord)
- Images en WebP/AVIF, dimensions déclarées, loading="lazy" sous la ligne de flottaison, l'image LCP en priorité (fetchpriority="high", pas lazy).
- JavaScript minimal : c'est le premier coupable. Découpe (code splitting), charge seulement ce qui est visible, defer/async sur tout script non critique.
- SSR ou SSG pour le contenu critique ; HTML complet dès la première réponse.
- Polices : preload de la police principale, font-display: swap, jamais de police bloquante ; polices système quand c'est possible.
- CDN devant le site, compression Brotli (Gzip à défaut), cache long (immutable) sur les assets statiques versionnés, HTTP/2 ou HTTP/3.
- Vérification : lire_code_site sur la page publiée, puis un contrôle des poids (HTML < 150 ko, images < 200 ko chacune, JS < 100 ko compressé) ; corriger avant de soumettre à IndexNow.

À NE PAS FAIRE (politique anti-spam Google : abus de domaine expiré, abus de réputation de site, contenu à grande échelle sans valeur)
- Racheter des domaines expirés pour les rediriger en 301 vers le site.
- Afficher une date de mise à jour sans vrai changement.
- Faire passer une page d'avis pour un tiers indépendant, ou un publireportage pour un article neutre.
- Sites parasites ou « burner domains » sur des plateformes à forte autorité.
- Signaux d'engagement simulés. Si Lionel demande l'une de ces méthodes, explique en une ligne le risque (perte du site entier) et propose l'équivalent propre : comparatif signé, page-outil, mention hors site réelle.`;

export const SUIVI_CITATIONS = `SUIVI DES CITATIONS ET DE L'INDEXATION (quotidien) :
1. Indexation : pour chaque page publiée depuis 14 jours, tavily_search avec l'URL exacte entre guillemets et serpapi_search « site:<domaine> » ; note indexée / pas encore. Une page absente après 7 jours → resoumettre via indexnow_submit et vérifier qu'elle est bien dans le sitemap et sans noindex.
2. Citations : tavily_search (topic news, 7 jours) sur « <marque> », « <domaine> », et sur 3 questions clés du site ; x_profile sur les comptes qui reprennent le sujet ; relève toute page ou tout post qui cite le site ou reprend ses chiffres.
3. Positions : pour 5 requêtes cibles, serpapi_search (si disponible) et note la position ; sinon, tavily_search et note si le site apparaît dans les 8 premiers.
4. Ajustements : pour chaque page qui n'apparaît pas, une action concrète (réponse directe plus nette dans les 150 premiers mots, H2 reformulé en question réelle, donnée datée ajoutée, FAQ enrichie, lien interne manquant), consignée dans /memories/seo/ajustements.md ; les 2 plus rentables sont déléguées au codeur et publiées.
5. Journal : /memories/seo/citations.md (date, page, indexée, citée par, position), et un bilan de 8 lignes envoyé à l'opérateur.`;
