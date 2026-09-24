# Bot SEO + GEO — sites complets, indexés et cités vite

Ce document décrit ce que Manzi Junior fait quand on lui demande un site ou des
pages optimisées pour Google **et** pour les moteurs de réponse (Grok, ChatGPT,
Perplexity, AI Overviews), avec le code qui le fait, les prompts internes et
la checklist de déploiement.

## 1. Plan

| Étape | Qui | Outils | Sortie |
|---|---|---|---|
| 1. Mots-clés et questions (web + X en direct) | planificateur (DeepSeek, réflexion haute) | `tavily_search`, `serpapi_search`, `x_profile` | liste de pages classée par intérêt × faiblesse des concurrents |
| 2. Concurrents et gaps | planificateur | `lire_code_site`, `site_audit` | ce qu'ils ne traitent pas, leurs H2, leur JSON-LD |
| 3. Pages complètes | planificateur écrit, codeur (Claude Code) intègre | `delegate_coding_task`, `sandbox_bash` | HTML sémantique, responsive, FAQ + JSON-LD, CTA |
| 4. Publication et indexation | codeur + outils git | `git_push_and_deploy`, `git_pull_request`, `indexnow_submit` | pages en 200, IndexNow 200/202, sitemap à jour |
| 5. Suivi quotidien | mission `citations_monitor` (7 h 15) | recherche web + X, `indexnow_submit`, codeur | journal `/memories/seo/citations.md`, 2 corrections max par jour |

Vitesse d'abord : la réflexion lourde (étapes 1 et 2) se fait une fois par
exécution ; le code est délégué page par page avec un cahier des charges fermé,
jamais réécrit deux fois. Cible : pages en ligne en moins de 30 minutes.

## 2. Le code

- `agent/src/seo-geo.ts` — les prompts internes (gabarit de page, robots et
  indexation, recherche de mots-clés, suivi des citations). Un seul endroit à
  modifier quand les règles changent.
- `agent/src/missions/index.ts` — missions `site_seo_geo` (sur ordre, budget
  6 $, 90 tours), `citations_monitor` (chaque matin, 1 $), et `seo_daily` qui
  applique le même gabarit à l'article du jour.
- `agent/src/tools/indexnow.ts` — clé IndexNow créée une fois (réglage
  `INDEXNOW_KEY`), soumission conforme à indexnow.org, vérification du
  fichier de clé, codes de réponse expliqués.
- `agent/src/tools/code-site.ts` — lecture du code d'un site concurrent (pile,
  services, SEO, JSON-LD, structure, signaux commerciaux) en un appel.
- `agent/src/tools/git.ts` — clonage de n'importe quel dépôt, push, pull request.
- `agent/src/dev.ts` — atelier de développement à la demande (branche, tests,
  PR), utilisé pour les corrections ponctuelles.

## 3. Lancer depuis WhatsApp

- « Crée un site sur l'IPTV légal en Suède, en suédois, 5 pages, dépôt tvking »
  → le bot lance `site_seo_geo` avec ce brief.
- « Fais les pages qui manquent face à bastiptv.example » → même mission, le
  concurrent est lu en premier.
- « Où en sont mes citations ? » → `citations_monitor` tout de suite.

## 4. Prompts internes

Ils sont dans `agent/src/seo-geo.ts` ; en résumé :

**Gabarit de page** : réponse directe dans les 150 premiers mots ; `<title>`
≤ 60 caractères, description 120–155 ; un H1 ; chaque H2 est une question
réelle suivie d'un bloc autonome de 60 à 200 mots ; chiffres datés et sourcés,
entités nommées, un tableau ou une liste quand ça s'y prête ; 800 mots minimum
et pas de remplissage ; FAQ de 4 à 8 questions avec JSON-LD FAQPage identique
au texte ; JSON-LD Article (+ Product/Offer, BreadcrumbList) valides ; HTML
sémantique et responsive, images webp/avif avec alt et dimensions ; 2 à 4 liens
internes ; CTA avant la ligne de flottaison et en fin de page ; auteur, date
de mise à jour, mentions légales ; langue du marché, canonical, hreflang.

**Indexation et accès des IA** : robots.txt qui autorise tout et déclare le
sitemap ; aucun robot d'IA bloqué (GPTBot, OAI-SearchBot, PerplexityBot,
ClaudeBot, Google-Extended, Applebot-Extended, Amazonbot, Bingbot ; pour Grok
les noms rapportés sont GrokBot, xAI-Grok, Grok-DeepSearch, xAI-Bot — non
documentés officiellement par xAI, et Grok se présente souvent comme un
navigateur ordinaire) ; sitemap.xml avec `lastmod` exact ; llms.txt ; fichier
de clé IndexNow à la racine ; soumission IndexNow après chaque déploiement.
Google n'écoute pas IndexNow : sitemap + Search Console.

**Recherche de mots-clés** : 5 à 8 requêtes web dans la langue du marché
(titres classés, « autres questions posées ») ; X via `x_profile` sur 3 à 5
comptes et recherche d'actualité (questions et mots exacts du moment) ;
lecture de 3 à 5 pages concurrentes ; le gap = questions posées que personne
ne traite proprement.

**Suivi** : indexation de chaque page publiée depuis 14 jours (resoumission
après 7 jours d'absence), citations (recherche du domaine, de la marque et de
3 questions clés, X), positions sur 5 requêtes (« non mesuré » si l'outil ne
rend pas la SERP), 2 corrections publiées par jour au plus, journal et bilan
de 8 lignes.

## 5. Checklist de déploiement

1. **Clés** (panneau → Services) : Tavily (recherche web), SerpAPI (positions,
   facultatif), GitHub (jeton avec `repo`), Vercel (déploiement), Anthropic
   (le codeur Claude Code l'exige). Vérifier chaque carte avec « Tester la clé ».
2. **Modèles** : `MODEL_CODER=claude-sonnet-5` dans le `.env` pour un code
   rapide ; le planificateur reste DeepSeek en réflexion haute (réglage
   « réflexion : auto »).
3. **Site** : `SITE_URL` et `GITHUB_REPO` dans le `.env` pointent sur le site à
   faire monter ; le dépôt est connecté à Vercel (push = déploiement).
4. **Première exécution** : « crée 3 pages sur <sujet> pour <marché> » sur
   WhatsApp ; vérifier le rapport : URL en 200, IndexNow 200 ou 202, sitemap.
5. **Fichier de clé IndexNow** : la première soumission dit si `/<clé>.txt`
   manque ; le codeur l'ajoute (dossier `public/`) et redéploie.
6. **Google Search Console** : ajouter le domaine, soumettre le sitemap (une
   fois, à la main : pas d'API sans OAuth).
7. **Budget** : `site_seo_geo` coûte jusqu'à 6 $ par exécution ; relever le
   plafond du jour si besoin (« monte le plafond à 10 »).
8. **Suivi** : `citations_monitor` tourne à 7 h 15 ; lire le bilan dans le
   rapport du matin ; « où en sont mes citations ? » pour le lancer à la main.

## 6. Ce qui reste hors de portée, dit franchement

- Personne ne peut garantir une citation par Grok ou ChatGPT : on maximise la
  probabilité (réponse directe, structure atomique, données, entités,
  accessibilité aux robots), on mesure, on ajuste.
- Google indexe à son rythme ; IndexNow accélère Bing, Yandex, Seznam, Naver.
- Les positions exactes demandent SerpAPI ; sans lui, le suivi dit « dans les
  8 premiers » ou « non mesuré », jamais un chiffre inventé.
