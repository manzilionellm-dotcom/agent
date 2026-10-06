# Manzi Junior

**Open source (MIT), auto-hébergé, sous tes ordres.** Rien ne tourne sans un ordre explicite (WhatsApp, Jarvis ou API) ou un planning que tu as toi-même ordonné ; aucune règle cachée, aucune mise à jour silencieuse ; chaque ligne se lit, se modifie, se forke et se déploie sur ton propre VPS. Guide depuis zéro : [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

Agent autonome 24/7 : veille web + X, surveillance des concurrents avec alertes, comparateur IPTV, article SEO/GEO quotidien, code → GitHub → Vercel, Gmail/agenda, audit de site, essaim de 19 sous-agents parallèles (dont grok_bot_mirror + flotte de création : forum_builder, landing_crafter, scrape_factory, automation_smith + SEO flotte : seo_crawl_flotte, gsc_schema_fix + mission fleet_health), couche vocale **Jarvis** (Whisper → Claude → Kokoro, voix féminine française), mémoire Postgres, rapport chaque matin, et auto-révision nocturne de ses propres playbooks.

```bash
curl -fsSL https://raw.githubusercontent.com/manzilionellm-dotcom/agent/main/install.sh | bash -s -- --eco
# --eco : VPS 4 Go, DeepSeek + Claude pour le code, WhatsApp, 25-45 €/mois (docs/ECO.md)
# --swarm : 5 sandboxes (VPS 16 Go)   ·   bash jarvis/install.sh : voix, sur ta machine
```

| Document | Contenu |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | multi-agents, boucle de raisonnement, mémoire, MCP, sandbox, sécurité, évolution quotidienne |
| [docs/HOSTING.md](docs/HOSTING.md) | Docker, VPS, clés API, coûts réels, fonctionnement continu, sauvegardes |
| [docs/SWARM.md](docs/SWARM.md) | les 19 rôles, plan → vagues parallèles → fusion, ce que « ÷10 » veut dire |
| [docs/JARVIS.md](docs/JARVIS.md) | installation, voix, modes d'éveil, mémoire SQLite, MCP |
| [docs/MODELS.md](docs/MODELS.md) | choix des modèles, DeepSeek/Kimi/Qwen, corrections de prémisses |
| [docs/ECO.md](docs/ECO.md) | mode économique : diff de config, variables, WhatsApp (Meta/Twilio), Chrome via tunnel, redéploiement |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | cloner et lancer depuis zéro, alternatives 100 % ouvertes, ce que « sans ordre » garantit |

Arborescence : `agent/` (orchestrateur Node), `jarvis/` (voix, Python), `docker/`, `deploy/`, `app/` (site Next.js 16 déployé sur Vercel — voir `AGENTS.md`).

Canal principal : WhatsApp (« lance la veille », « planifie le rapport à 7h30 », « montre le planning », « lance un essaim : … »). Navigateur : ton Chrome via tunnel SSH (mode « Claude dans Chrome ») ou Chromium persistant du sandbox.

Commandes utiles :

```bash
docker compose logs -f orchestrator
docker compose exec orchestrator node dist/cli.js veille | seo_daily | competitor_watch | site_audit | report | reflect
docker compose exec orchestrator node dist/cli.js swarm "objectif complet…"
curl -s http://127.0.0.1:8787/healthz | jq
```

## Site Next.js (`app/`)

Bootstrappé avec `create-next-app` (Next 16, React 19, Tailwind 4). `npm run dev` puis http://localhost:3000. Lire `node_modules/next/dist/docs/` avant de modifier : cette version a des changements cassants.

## Grok Bots

Synchronisation quotidienne avec les Grok Bots de Lionel via la mission `grok_bots_sync` (cron 04:00). Le rôle `grok_bot_mirror` reproduit leurs réflexes natifs. Flotte de création : `forum_builder`, `landing_crafter`, `scrape_factory`, `automation_smith` — créent communautés, landings, scrapers et workflows à la demande. SEO flotte : `seo_crawl_flotte`, `gsc_schema_fix` + mission nocturne `fleet_health` (cron 01:00) — crawl, GSC/schema, preuves curl, issues par régression, WA https://wa.me/447307410512 ; jamais d'AggregateRating inventé.
