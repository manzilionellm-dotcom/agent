# Essaim — 18 sous-agents parallèles

## Lancer

```bash
# Stack avec 5 sandboxes dédiés (un par agent code en parallèle)
docker compose -f docker-compose.yml -f docker-compose.swarm.yml up -d --build
# ou : ./install.sh --swarm

# Un objectif, en ligne de commande
docker compose exec orchestrator node dist/cli.js swarm \
  "Relever les tarifs des 10 fournisseurs du comparateur, mettre à jour data/providers.json, vérifier le build, déployer, et me faire un tableau des écarts vs le mois dernier"

# Par l'API (Jarvis fait pareil)
curl -H "Authorization: Bearer $ORCHESTRATOR_TOKEN" -H 'content-type: application/json' \
  -d '{"objective":"…","budgetUsd":12}' http://127.0.0.1:8787/swarm      # → {"id":"sw_…"}
curl -H "Authorization: Bearer $ORCHESTRATOR_TOKEN" http://127.0.0.1:8787/swarm/sw_…
```

## Comment ça marche (`agent/src/swarm/`)

1. **Plan** — un appel structuré (Opus 5, effort high) transforme l'objectif en 3 à 12 sous-tâches, chacune avec un rôle, un cahier des charges auto-suffisant, des critères d'acceptation et des dépendances. Le DAG est validé (ids uniques, pas de cycle) avant toute exécution.
2. **Vagues parallèles** — tout ce dont les dépendances sont satisfaites part en même temps, jusqu'à `SWARM_CONCURRENCY` (10). Un rôle qui touche du code prend un conteneur dans `SANDBOX_POOL` (attend s'il n'y en a plus). Chaque sous-agent : son prompt système, sa mémoire (`/memories/agents/<rôle>`), ses outils, son budget ; il reçoit les `<result>` de ses dépendances, rien d'autre.
3. **Fusion** — le coordinateur relit tous les résultats, tranche les contradictions, produit le livrable, la liste des actions humaines et les points ouverts. Tout est journalisé (`episodes` : `swarm` + `swarm:<rôle>`), avec durée mur et estimation séquentielle pour mesurer le gain.

## Les 18 rôles

| Rôle | Modèle | Sandbox | Outils clés | Livrable |
|---|---|---|---|---|
| researcher | Sonnet 5 | non | web/tavily, x_search | synthèse sourcée, 2 sources par affirmation |
| scraper | Sonnet 5 | oui | scrape_page, tavily_extract | JSON structuré avec URL + horodatage par champ |
| competitor_watch | Sonnet 5 | non | recherche, recall_facts, send_alert | deltas uniquement, alertes vérifiées |
| seo_writer | Opus 5 | non | recherche | article complet (frontmatter + corps) dans `/memories/drafts/` |
| coder | Opus 5 | oui | delegate_coding_task, sandbox, git_ensure_repo | commits sur branche `swarm/<date>-<slug>`, tests verts |
| qa | Opus 5 | oui | sandbox, site_audit | GO / NO-GO avec preuves |
| publisher | Sonnet 5 | oui | sandbox, git | contenu intégré au bon format, build vert, commit |
| deployer | Sonnet 5 | oui | git_push_and_deploy, vercel MCP | URL en prod vérifiée (200 + contenu attendu) |
| inbox | Sonnet 5 | non | gmail, gcal (dry-run) | tri, brouillons, créneaux |
| analyst | Opus 5 | oui | sandbox (python/node), site_audit | chiffres calculés par code, méthode visible |
| grok_bot_mirror | Opus 5 (critical) | oui | sandbox, coder, git, audit, browser, search, alert | réflexe Grok Bot natif : intuition, vitesse <30s, mémoire vive du profil Lionel, anti-jobs, coordination Versel/GitHub, rapports au Premier Ministre |
| forum_builder | Opus 5 (critical) | oui | sandbox, coder, git, audit, browser, search, alert | communauté complète : DB, API, UI, modération, déploiement Vercel |
| landing_crafter | Opus 5 (critical) | oui | sandbox, coder, git, audit, browser, search, alert | landing de conversion : copy, tracking, Lighthouse > 90, preview Vercel |
| scrape_factory | Sonnet 5 | oui | sandbox, coder, git, scrape, browser, search, alert | module de scraping réutilisable : parser, scheduler, stockage, alertes |
| automation_smith | Opus 5 (critical) | oui | sandbox, coder, git, audit, browser, search, alert | workflow self-healing : triggers, actions, retry, logs, doc |
| seo_crawl_flotte | Sonnet 5 | oui | sandbox, audit, browser, search, alert | tableau de santé de la flotte IPTV (HTTP, canonical, hreflang, schema, CTA WA) |
| gsc_schema_fix | Opus 5 (critical) | oui | sandbox, coder, git, audit, search, alert | JSON-LD corrigé + issues GSC, 0 AggregateRating inventé |
| self_healer | Opus 5 (critical) | oui | sandbox, coder, git, audit, alert | bots/sites/process réparés sans attendre Lionel |

Ajouter un rôle : une entrée dans `swarm/roles.ts` (description, modèle, effort, budget, outils, prompt). Le planificateur le voit immédiatement.

## Intégration Grok Bots

Le rôle `grok_bot_mirror` est le pont entre Manzi Junior et les Grok Bots de Lionel. Il reproduit leurs réflexes : intuition (devine l'intention avant qu'on finisse de parler), vitesse (<30s sur ordres simples), mémoire vive du profil Lionel (projets IPTV flotte, casquettes, eSIM, Vinted, pépites nordiques ; règles soft-sell, 0 M3U, 0 AggregateRating inventé, WA +44 7307 410512), réflexe natif sur un seul mot ("Build" = construis, "Sucre" = résume et exécute, "Pro" = monte le niveau), auto-amélioration continue vers 80% de réflexe Grok Bot, anti-jobs (soft-sell white-hat, preuves curl), coordination Versel/GitHub/Seo Wa Landing, rapports au Premier Ministre Manzi.

La mission quotidienne `grok_bots_sync` (cron 04:00) synchronise les rôles/missions du dépôt avec les Grok Bots actifs : lit la liste, vérifie la fidélité des descriptions, propose des ajouts sans toucher à l'existant, ouvre une PR vers main, rapporte dans `/memories/grok-bots/`.

## Flotte de création

Quatre rôles spécialisés dans la création de produits web à la demande :
- **forum_builder** : crée des forums et communautés (schéma DB, routes API, UI Next.js, règles de modération, anti-spam, soft-sell). Livrable : repo branché + preview Vercel + README d'exploitation.
- **landing_crafter** : crée des landings de conversion (hero, proposition de valeur, preuve sociale sourcée, CTA unique, tracking Plausible/Umami, responsive, Lighthouse > 90). Livrable : branche + preview Vercel + curl HTTP 200.
- **scrape_factory** : fabrique des outils de scraping réutilisables (parsers modulaires, scheduler cron, stockage Postgres, alertes sur delta). Livrable : module testé + doc d'usage + preuve de run.
- **automation_smith** : crée des workflows self-healing (triggers webhook/cron/event, actions API/git/deploy/notify, conditions, retry backoff, logs, détection d'échec → correction → relance). Livrable : workflow JSON/YAML + code + test de run + doc.

Ces rôles peuvent aussi créer d'autres bots spécialisés (forums, communautés, landings, scrapers, automatisations) à la demande de Lionel, coordonnés par grok_bot_mirror.

## Rôles de surveillance flotte

Deux rôles dédiés à la santé de la flotte IPTV :
- **seo_crawl_flotte** : crawl quotidien de tous les sites IPTV (testiptv24h.com, latinoiptvbox.com, iptvpremiumpolska.com, iptvnyc.us, nigeriaiptv.com, worldiptv1.com, iptv-sport.com, premiumlatinoiptv.us, iptv-toronto.ca, stableiptv.ca, iptvusastream.com). Vérifie HTTP 200, canonical, hreflang, JSON-LD, pages 404/minces, Lighthouse, CTA WhatsApp +44 7307 410512. Ouvre une issue GitHub par régression.
- **gsc_schema_fix** : corrige les données structurées (FAQPage, HowTo, Product/Offer, Organization) et signale les problèmes Search Console. 0 AggregateRating inventé, 0 M3U, soft-sell.

## Ce que « diviser le temps par dix » veut dire vraiment

FAIT : le gain est proportionnel à la part parallélisable de l'objectif.

- « Relever 10 fournisseurs » → 10 scrapers en parallèle : mur ≈ le plus lent (2–3 min) au lieu de 25 min. Gain ~8×.
- « Écrire 5 articles » → 5 rédacteurs : gain ~5×, puis 1 publisher + 1 deployer en séquence.
- « Corriger un bug, tester, déployer » → chaîne coder → qa → deployer : gain 1× (mais la QA indépendante évite un déploiement cassé, ce qui vaut plus que du temps).

Bornes réelles : débit API (tokens/minute) qui plafonne vers 6–8 agents simultanés sur un tier standard ; RAM du VPS (1,5 Go par sandbox actif) ; les sites cibles (cadence). Le coordinateur journalise `wallSeconds` et l'estimation séquentielle : c'est ton chiffre, pas une promesse.

## Garde-fous

- Budget global par essaim (`SWARM_BUDGET_USD`, 15 $ par défaut, surchargeable par appel) ; une sous-tâche qui dépasse coupe net, les dépendantes sont « skipped », la fusion le dit.
- Une dépendance en échec n'exécute pas ses dépendants (pas de déploiement d'un code que la QA a refusé).
- Les rôles code ne travaillent jamais sur `main` ; seul `deployer` pousse, uniquement après un GO.
- Un conteneur sandbox par agent code : pas de collision de fichiers ni de `node_modules`.
- Les outils MCP irréversibles restent en dry-run sauf pour `deployer` (`allowIrreversible`).
