# Manzi Junior — Architecture

Agent autonome 24/7 pour un opérateur solo : veille web + X, comparateur IPTV, contenu SEO/GEO quotidien, code → GitHub → Vercel, Gmail/agenda, audit de site, surveillance des concurrents, essaim de 11 sous-agents (dont grok_bot_mirror), couche vocale Jarvis, rapport chaque matin, synchronisation quotidienne avec les Grok Bots de Lionel.

Ce document explique les choix. Le code est la référence : `agent/src/`.

## 1. Vue d'ensemble

```
                 ┌──────────────────────────── VPS (Docker) ────────────────────────────┐
                 │                                                                     │
  WhatsApp ──────┼──► webhook signé /whatsapp/webhook (Cloudflare Tunnel)              │
  Jarvis (voix)  │  orchestrator (Node 22)                                             │
  sur ton PC ────┼──► API HTTP 127.0.0.1:8787 (Bearer) · POST /chat                     │
  Whisper/Kokoro │       │                                                             │
                 │       ├── scheduler (croner + verrous Postgres)                     │
                 │       │      AUTONOMY_MODE=manual : RIEN sans ordre ; planning      │
                 │       │      ordonné en base (schedules). scheduled : crons défaut  │
                 │       │      veille 05:00 · concurrents 05:15 · seo 06:30 · …       │
                 │       │                                                             │
                 │       ├── runAgent()  ── Claude tool runner (ou OpenAI-compat)       │
                 │       │      outils client: sandbox, git, coder, x, tavily, audit…  │
                 │       │      outils serveur: web_search, web_fetch (Claude)         │
                 │       │      MCP: github, gmail, gcal, vercel (allowlist + gating)  │
                 │       │                                                             │
                 │       ├── swarm/coordinator ── plan (DAG) → vagues // → fusion       │
                 │       │      11 rôles, mémoire par rôle, pool de sandboxes          │
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

## 7. Essaim (11 sous-agents)

Voir `docs/SWARM.md`. Résumé : plan structuré (DAG de sous-tâches typées par rôle) → exécution par vagues parallèles (concurrence bornée, pool de sandboxes, budget global) → fusion par le coordinateur (livrable + actions humaines + points ouverts). Rôles : researcher, scraper, competitor_watch, seo_writer, coder, qa, publisher, deployer, inbox, analyst, **grok_bot_mirror**.

### Intégration Grok Bots

Le rôle `grok_bot_mirror` reproduit les réflexes natifs des Grok Bots de Lionel : intuition (devine l'intention avant qu'on finisse de parler), vitesse (<30s sur ordres simples), mémoire vive du profil Lionel (projets IPTV flotte, casquettes, eSIM, Vinted, pépites nordiques ; règles soft-sell, 0 M3U, 0 AggregateRating inventé, WA +44 7307 410512), réflexe natif sur un seul mot, auto-amélioration continue vers 80% de réflexe Grok Bot, anti-jobs (soft-sell white-hat, preuves curl), coordination Versel/GitHub/Seo Wa Landing, rapports au Premier Ministre Manzi.

La mission quotidienne `grok_bots_sync` (cron 04:00) lit la liste des Grok Bots actifs, vérifie que rôles/missions du dépôt reflètent fidèlement leurs descriptions, propose des ajouts sans toucher à l'existant, ouvre une PR vers main, et rapporte dans `/memories/grok-bots/`.

Pourquoi pas LangGraph : la logique (plan → DAG → fusion) tient en 250 lignes lisibles dans `swarm/coordinator.ts`, sans dépendance ni abstraction à apprendre, avec le tool runner officiel qui gère déjà la boucle d'outils, la compaction et le streaming. LangGraph apporte de la valeur pour des graphes cycliques complexes à état partagé ; ici, le graphe est un DAG planifié par le modèle, et l'ajout d'un framework coûterait plus qu'il ne rapporte. Si tu veux LangGraph malgré tout, `runSwarm()` se réécrit en un `StateGraph` de trois nœuds ; rien d'autre ne change.
