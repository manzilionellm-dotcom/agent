# Manzi Junior

Agent autonome 24/7 : veille web + X, surveillance des concurrents avec alertes, comparateur IPTV, article SEO/GEO quotidien, code → GitHub → Vercel, Gmail/agenda, audit de site, essaim de 10 sous-agents parallèles, couche vocale **Jarvis** (Whisper → Claude → Kokoro, voix féminine française), mémoire Postgres, rapport chaque matin, et auto-révision nocturne de ses propres playbooks.

```bash
curl -fsSL https://raw.githubusercontent.com/manzilionellm-dotcom/agent/main/install.sh | bash
# puis : ./install.sh --swarm (5 sandboxes)   ·   bash jarvis/install.sh (voix, sur ta machine)
```

| Document | Contenu |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | multi-agents, boucle de raisonnement, mémoire, MCP, sandbox, sécurité, évolution quotidienne |
| [docs/HOSTING.md](docs/HOSTING.md) | Docker, VPS, clés API, coûts réels, fonctionnement continu, sauvegardes |
| [docs/SWARM.md](docs/SWARM.md) | les 10 rôles, plan → vagues parallèles → fusion, ce que « ÷10 » veut dire |
| [docs/JARVIS.md](docs/JARVIS.md) | installation, voix, modes d'éveil, mémoire SQLite, MCP |
| [docs/MODELS.md](docs/MODELS.md) | Claude par défaut, DeepSeek/Kimi/Qwen en option, corrections de prémisses |

Arborescence : `agent/` (orchestrateur Node), `jarvis/` (voix, Python), `docker/`, `deploy/`, `app/` (site Next.js 16 déployé sur Vercel — voir `AGENTS.md`).

Commandes utiles :

```bash
docker compose logs -f orchestrator
docker compose exec orchestrator node dist/cli.js veille | seo_daily | competitor_watch | site_audit | report | reflect
docker compose exec orchestrator node dist/cli.js swarm "objectif complet…"
curl -s http://127.0.0.1:8787/healthz | jq
```

## Site Next.js (`app/`)

Bootstrappé avec `create-next-app` (Next 16, React 19, Tailwind 4). `npm run dev` puis http://localhost:3000. Lire `node_modules/next/dist/docs/` avant de modifier : cette version a des changements cassants.
