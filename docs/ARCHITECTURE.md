# Manzi Junior — Architecture

Agent autonome 24/7 pour un opérateur solo : veille web + X, comparateur IPTV, contenu SEO/GEO quotidien, code → GitHub → Vercel, Gmail/agenda, audit de site, surveillance des concurrents, essaim de 10 sous-agents, couche vocale Jarvis, rapport chaque matin.

Ce document explique les choix. Le code est la référence : `agent/src/`.

## 1. Vue d'ensemble

```
                 ┌──────────────────────────── VPS (Docker) ────────────────────────────┐
                 │                                                                     │
  Jarvis (voix)  │  orchestrator (Node 22)                                             │
  sur ton PC ────┼──► API HTTP 127.0.0.1:8787 (Bearer)                                 │
  Whisper/Kokoro │       │                                                             │
                 │       ├── scheduler (croner + verrous Postgres)                     │
                 │       │      veille 05:00 · competitor_watch 05:15 · seo_daily 06:30│
                 │       │      inbox 07/13/18 · iptv lun/jeu 04:00 · audit mar 02:00  │
                 │       │      repo dim 03:00 · reflect 23:30 · rapport 07:30         │
                 │       │                                                             │
                 │       ├── runAgent()  ── Claude tool runner (ou OpenAI-compat)       │
                 │       │      outils client: sandbox, git, coder, x, tavily, audit…  │
                 │       │      outils serveur: web_search, web_fetch (Claude)         │
                 │       │      MCP: github, gmail, gcal, vercel (allowlist + gating)  │
                 │       │                                                             │
                 │       ├── swarm/coordinator ── plan (DAG) → vagues // → fusion       │
                 │       │      10 rôles, mémoire par rôle, pool de sandboxes          │
                 │       │                                                             │
                 │       └── memory/ ── Postgres : memory_files, facts, tasks,          │
                 │                       episodes, spend, reports                      │
                 │                                                                     │
                 │  sandbox(es) (Chromium, Claude Code, Lighthouse, git, node, python) │
                 │  db (Postgres 16) · backup (pg_dump quotidien)                      │
                 └─────────────────────────────────────────────────────────────────────┘
```

Trois principes qui font la différence entre un démo et un système qui tient six mois :

1. **Une mission = un contrat.** Cahier des charges complet, critères de succès mesurables, budget en dollars, nombre max de tours. Le modèle reçoit tout d'un coup ; il ne « discute » pas.
2. **Tout effet de bord passe par un outil typé et audité** (`git_push_and_deploy`, `send_alert`, `remember_fact`), jamais par du bash libre quand un outil existe. C'est ce qui permet le gating (dry-run), la journalisation et le cache.
3. **La mémoire est le produit.** Le modèle est jetable ; ce qui s'accumule dans Postgres (faits sourcés, playbooks, décisions, épisodes) est ce qui rend l'agent meilleur chaque semaine.

## 2. Boucle de raisonnement

`agent/src/llm.ts` → `runAgent()` :

```
system (stable, caché 1h)  +  <playbook> + tâche + <memoire>  (volatile)
        │
        ▼
   ┌─ tour n ───────────────────────────────────────────────┐
   │ Claude pense (adaptive thinking, effort par mission)     │
   │ → texte + N appels d'outils (parallèles)                 │
   │ → le runner exécute les outils, valide les entrées (Zod) │
   │ → résultats renvoyés en un seul message                  │
   │ → compaction serveur si le contexte grossit              │
   │ → coût cumulé ; arrêt si budget > plafond                │
   └──────────────────────────────────────────────────────────┘
        │ stop_reason = end_turn | refusal | budget_exceeded
        ▼
   épisode journalisé (statut, USD, tours, résumé) → rapport du matin
```

Détails qui comptent :

- **Plan → Act → Verify → Memorize → Report** est imposé par le prompt système (`prompts.ts`), pas par du code : sur Opus 5 / Fable 5, un cadre clair bat une machine à états rigide.
- **Effort** : `medium` pour la veille (Sonnet 5), `high` pour le code et la fusion (Opus 5). C'est le premier levier coût/qualité, avant le choix du modèle.
- **Compaction serveur** (`compact_20260112`) : le contexte est résumé automatiquement ; une mission de 80 tours tient sans intervention.
- **Fallback sur refus** (`fallbacks: "default"`) : un refus de sécurité est réacheminé côté serveur ; sinon `stop_reason = refusal` est journalisé et la mission s'arrête proprement.
- **Streaming + `finalMessage()`** : les tours longs (minutes) ne tombent pas en timeout HTTP.
- **Budget dur** : compteur USD par mission et par jour (`spend`). Le scheduler refuse de lancer au-delà du plafond journalier.
- **`max_tokens` atteint** : l'entrée d'outil tronquée échoue à la validation Zod ; le modèle reçoit l'erreur et recommence, plafond relevé.

## 3. Mémoire persistante (Postgres)

| Table | Rôle | Qui écrit |
|---|---|---|
| `memory_files` | Mémoire « fichiers » `/memories/...` via l'outil natif `memory_20250818`. Notes, playbooks, backlog SEO, brouillons. | Le modèle, librement |
| `facts` | Faits atomiques sourcés, datés, avec confiance et expiration. Full-text (`tsvector`). | `remember_fact` |
| `tasks` | Kanban multi-jours. | `task_board` |
| `episodes` | Journal immuable de chaque mission et sous-agent : statut, coût, tours, résumé, erreur. | L'orchestrateur |
| `spend` | Dépense par jour (plafond). | L'orchestrateur |
| `reports` | Rapports du matin. | `report.ts` |

Namespaces : le planificateur voit `/memories`, le sous-agent `scraper` voit `/memories/agents/scraper` (re-basé de façon transparente : il écrit `/memories/x.md`, c'est stocké sous son préfixe). Chaque agent a donc sa mémoire, sans fuite entre rôles ; le coordinateur, lui, peut tout lire.

Pourquoi pas de base vectorielle : à l'échelle d'un opérateur solo (quelques milliers de faits), la recherche full-text Postgres avec `websearch_to_tsquery` est plus prévisible qu'un embedding, ne coûte rien, et le modèle formule bien ses requêtes. Si tu dépasses ~50 000 faits, ajoute `pgvector` + Voyage AI ; le schéma le permet sans migration cassante.

## 4. Évolution quotidienne (ce que « il apprend » veut dire concrètement)

Les poids du modèle ne changent pas. L'agent évolue par trois mécanismes codés :

1. **Mémoire** (ci-dessus) : faits, préférences, décisions, échecs.
2. **Playbooks auto-révisés** — mission `reflect` (23:30) : relit `episodes` des 24 h (`read_episodes`), écrit/élague `/memories/playbooks/<mission>.md` (RÈGLES / PIÈGES / RACCOURCIS avec preuve), `_global.md` (principes transverses), `_metrics.md` (taux de succès et coût 7 jours). Chaque mission reçoit son playbook en tête de prompt (`<playbook>`), et le prompt système dit qu'il prime. Une règle contredite par les faits est supprimée : c'est une liste vivante, pas un journal.
3. **Auto-modification du code par PR** — le dimanche, `reflect` peut faire modifier `agent/src/` (prompts, cahiers des charges, budgets, outils) sur une branche `evolve/<date>` via le sous-agent codeur, typecheck vert. Il ne pousse pas ; le rapport du matin te propose la PR. Tu restes le seul à fusionner.

Mesure : `_metrics.md` et la table `episodes`. Si le taux de succès d'une mission ne monte pas en 3 semaines, c'est le cahier des charges qu'il faut changer, pas le modèle.

## 5. Outils

### Outils client (exécutés par l'orchestrateur)

| Outil | Fichier | Rôle |
|---|---|---|
| `sandbox_bash` / `sandbox_read_file` / `sandbox_write_file` | `tools/sandbox.ts` | Exécution dans le conteneur sandbox (timeout, sortie plafonnée, liste noire) |
| `delegate_coding_task` | `tools/coder.ts` | Claude Code headless (`claude -p`) dans le sandbox : le harnais complet (édition, tests, git) sans le réécrire |
| `git_ensure_repo` / `git_push_and_deploy` | `tools/git.ts` | Clone/maj, push fast-forward, suivi du déploiement Vercel jusqu'à READY/ERROR |
| `scrape_page` | `tools/web.ts` | Playwright/Chromium pour les pages JS |
| `x_search` | `tools/x.ts` | API X v2 officielle (recent search) |
| `tavily_search` / `tavily_extract` / `serpapi_search` | `tools/search.ts` | Recherche temps réel indépendante du fournisseur LLM ; SERP Google pour le SEO |
| `site_audit` | `tools/audit.ts` | Lighthouse + checklist SEO/GEO + robots/sitemap/llms.txt |
| `send_alert` | `tools/notify.ts` | Alerte Telegram immédiate (changement vérifié uniquement) |
| `memory` / `remember_fact` / `recall_facts` / `task_board` / `read_episodes` | `memory/store.ts` | Mémoire |

### Outils serveur Anthropic (zéro infra)

`web_search_20260209` et `web_fetch_20260209` : recherche et lecture avec citations, filtrage dynamique. Disponibles uniquement avec `LLM_PROVIDER=anthropic`. `pause_turn` est repris automatiquement.

### MCP (`agent/mcp.json`)

Chaque serveur est déclaré avec `allow` (liste blanche d'outils) et `confirm` (outils irréversibles exécutés en dry-run sauf mission `allowIrreversible`). Les outils sont préfixés `<serveur>__`. Les serveurs HTTP (GitHub, Vercel) passent en Streamable HTTP avec en-tête Bearer ; Gmail/Agenda en stdio (OAuth Google local, fichiers dans `./secrets`).

Pourquoi ne pas exposer les 80 outils du serveur GitHub : chaque schéma d'outil coûte des tokens à chaque tour, dilue l'attention, et élargit la surface d'attaque (injection via contenu de PR/issue). Dix outils bien choisis par mission.

## 6. Sandbox

- Conteneur dédié, image `docker/Dockerfile.sandbox` : Node 22, Python 3, git, Chromium/Playwright, Claude Code, Vercel CLI, Lighthouse.
- `cap_drop: ALL`, `no-new-privileges`, `pids_limit`, RAM/CPU bornés, `/tmp` en tmpfs, `/work` persistant (volume).
- L'orchestrateur a le socket Docker **mais le modèle n'y touche jamais** : il ne voit que `sandbox_bash`, qui fait `docker exec <conteneur choisi par l'orchestrateur>`. Le nom du conteneur n'est pas un paramètre du modèle.
- Le token GitHub n'est jamais écrit dans le sandbox : injecté dans l'URL au moment du fetch/push, et masqué dans les sorties.
- Liste noire de commandes (`rm -rf /`, force-push, fork bomb…) : dernier filet, pas la sécurité principale.
- Mode essaim : `docker-compose.swarm.yml` crée 5 sandboxes ; un agent code = un conteneur = un clone git. Zéro conflit de fichiers entre agents.

Niveau supérieur si tu héberges du code tiers non fiable : gVisor (`runsc`) ou Firecracker. Pour ton propre dépôt, l'isolation Docker durcie suffit.

## 7. Essaim (10 sous-agents)

Voir `docs/SWARM.md`. Résumé : plan structuré (DAG de sous-tâches typées par rôle) → exécution par vagues parallèles (concurrence bornée, pool de sandboxes, budget global) → fusion par le coordinateur (livrable + actions humaines + points ouverts). Rôles : researcher, scraper, competitor_watch, seo_writer, coder, qa, publisher, deployer, inbox, analyst.

Pourquoi pas LangGraph : la logique (plan → DAG → fusion) tient en 250 lignes lisibles dans `swarm/coordinator.ts`, sans dépendance ni abstraction à apprendre, avec le tool runner officiel qui gère déjà la boucle d'outils, la compaction et le streaming. LangGraph apporte de la valeur pour des graphes cycliques complexes à état partagé ; ici, le graphe est un DAG planifié par le modèle, et l'ajout d'un framework coûterait plus qu'il ne rapporte. Si tu veux LangGraph malgré tout, `runSwarm()` se réécrit en un `StateGraph` de trois nœuds ; rien d'autre ne change.

## 8. Couche vocale Jarvis

Voir `docs/JARVIS.md`. Tourne sur la machine avec le micro (pas sur le VPS). Whisper (faster-whisper) en entrée, Silero VAD pour le découpage, Kokoro-82M voix féminine française `ff_siwis` en sortie, Claude + MCP + mémoire SQLite locale, et délégation des tâches longues à Manzi Junior via l'API HTTP.

## 9. Sécurité et conformité

- **Injection de prompt** : tout contenu web, e-mail, issue, résultat d'outil est une donnée, jamais une instruction. Le prompt système le dit ; les outils irréversibles sont gatés ; les envois d'e-mail sont en dry-run hors mission autorisée.
- **Secrets** : `.env` (jamais commité), `./secrets` monté en lecture seule, redaction dans les logs, token GitHub masqué dans les sorties.
- **X** : API officielle uniquement. Le scraping de x.com viole les CGU et se fait bloquer ; ce n'est pas une option.
- **Scraping concurrents** : `robots.txt` respecté, user-agent identifiable, pas de contournement anti-bot. Relever des prix publics est licite en France (données publiques, pas de contournement de mesure technique) ; republier des contenus concurrents ne l'est pas.
- **IPTV** : le comparateur couvre des services légaux (opérateurs, plateformes, FAST). Comparer ou promouvoir des offres pirates engage ta responsabilité (L.335-2-1 CPI, ARCOM) ; le prompt de la mission l'exclut explicitement.
- **Réseau** : Postgres sur un réseau Docker interne sans route sortante ; API HTTP liée à 127.0.0.1 ; seul SSH est ouvert sur le VPS.

## 10. Choix de modèles

Voir `docs/MODELS.md` pour le détail (et les vérités inconfortables). Défaut : Claude Opus 5 (planification, code, fusion) + Claude Sonnet 5 (veille, scraping, publication). Alternative branchée : tout endpoint compatible OpenAI (DeepSeek, Kimi, Qwen, OpenRouter, vLLM local) via `LLM_PROVIDER=openai_compat`, avec Tavily/SerpAPI pour remplacer les outils serveur.

## 11. Fichiers

```
agent/src/
  index.ts          démon : migrations, MCP, scheduler, API HTTP
  cli.ts            lancement manuel : mission | report | swarm
  config.ts         env validé (fail-fast)
  llm.ts            runAgent(), structured(), prix, budget
  llm/openaiCompat.ts  boucle agentique pour DeepSeek/Kimi/Qwen/…
  prompts.ts        prompt système (stable → cache)
  scheduler.ts      croner + advisory locks + plafond journalier
  memory/           db, migrations, store (memory tool, facts, tasks, episodes)
  mcp/registry.ts   connexion MCP, allowlist, gating
  tools/            sandbox, coder, git, web, x, search, audit, notify
  missions/         missions planifiées + rapport du matin
  swarm/            rôles + coordinateur
jarvis/             couche vocale (Python)
docker/             Dockerfiles orchestrateur + sandbox
docker-compose.yml  stack de base ; docker-compose.swarm.yml : 5 sandboxes
install.sh          installation en une commande
deploy/             bootstrap VPS, restauration
```
