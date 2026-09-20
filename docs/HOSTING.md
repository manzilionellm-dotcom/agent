# Hébergement 24/7 — guide complet

Objectif : Manzi Junior tourne sans interruption, survit aux redémarrages, ne dépasse pas ton budget, et tu peux tout restaurer en 5 minutes.

## 0. Installation en une commande

Sur un VPS Debian 12 / Ubuntu 24.04 (ou ta machine Linux/macOS avec Docker) :

```bash
curl -fsSL https://raw.githubusercontent.com/manzilionellm-dotcom/agent/main/install.sh | bash
```

Ou depuis un clone : `./install.sh` (ajoute `--swarm` pour 5 sandboxes, `--jarvis` pour la voix sur une machine avec micro).

Le script installe Docker si besoin, génère `.env` (mot de passe Postgres + token API aléatoires) et `agent/mcp.json`, puis **s'arrête en te listant les clés manquantes**. Tu les renseignes, tu relances, il construit et démarre. Première construction : 5 à 10 minutes (Chromium, Claude Code, Lighthouse).

VPS vierge en root ? `bash deploy/vps-bootstrap.sh manzi https://github.com/manzilionellm-dotcom/agent.git` fait en plus : utilisateur non-root, pare-feu (SSH seul), SSH par clé uniquement, mises à jour automatiques, swap, service systemd.

## 1. Dimensionnement

| Profil | VPS | RAM | Prix/mois (2026, ordre de grandeur) | Fournisseurs |
|---|---|---|---|---|
| Base (missions séquentielles) | 2 vCPU | 4 Go + 2 Go swap | 4–8 € | Hetzner CX22, OVH VPS-1, Contabo |
| Essaim (5 sandboxes) | 4 vCPU | 16 Go | 15–25 € | Hetzner CX42, OVH VPS-3 |
| Jarvis (voix) | ta machine locale | 8 Go, CPU récent | 0 € | (GPU NVIDIA 4 Go+ = latence ÷ 2) |

Ce qui consomme : Chromium (Lighthouse, scraping) ~600 Mo par instance, `npm run build` Next.js ~1,5 Go pic, Claude Code ~300 Mo. Postgres et l'orchestrateur sont négligeables (< 300 Mo).

Disque : 40 Go suffisent (images ~4 Go, volumes `/work` ~2 Go par sandbox, sauvegardes < 100 Mo).

## 2. Clés API et où les créer

| Variable | Où | Périmètre minimal | Coût |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys | clé de workspace dédié « manzi » (limite de dépense mensuelle réglée dans la console) | usage |
| `GITHUB_TOKEN` | GitHub → Settings → Developer settings → Fine-grained tokens | **1 dépôt**, Contents RW, Pull requests RW, Issues RW, Metadata R. Expiration 90 j. | 0 |
| `VERCEL_TOKEN` | vercel.com → Account → Tokens | scope = ton équipe/projet ; `VERCEL_PROJECT` = id `prj_…` (Project settings → General) | 0 (Hobby) / 20 $ (Pro) |
| `X_BEARER_TOKEN` | developer.x.com → projet → App → Keys | plan **Basic** (recent search, 10 000 tweets lus/mois) | ~100 $/mois — vérifier le tarif courant ; le plan Free ne permet pas la lecture |
| `TAVILY_API_KEY` | app.tavily.com | — | gratuit 1 000 crédits/mois, puis ~30 $/mois |
| `SERPAPI_API_KEY` | serpapi.com | — | gratuit 100 recherches/mois, puis 75 $/mois (5 000) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | @BotFather → nouveau bot ; chat id via @userinfobot | — | 0 |
| Gmail / Agenda (MCP) | console.cloud.google.com → projet → OAuth client « Desktop » → télécharger `gcp-oauth.keys.json` dans `./secrets/` ; activer Gmail API + Calendar API ; ajouter ton adresse en « test user » | scopes gmail.modify + calendar | 0 |
| `ORCHESTRATOR_TOKEN` | généré par `install.sh` | API locale (Jarvis) | 0 |

Premier lancement Gmail : le serveur MCP ouvre un flux OAuth. Sur un VPS sans navigateur, fais l'authentification **une fois en local** (`npx @gongrzhe/server-gmail-autoauth-mcp auth`), puis copie `~/.gmail-mcp/credentials.json` dans `./secrets/gmail-credentials.json`. Le refresh token dure tant que l'app OAuth reste en « test » (7 jours si tu n'as pas publié l'app : publie-la en « production » sans validation Google, c'est autorisé pour un usage personnel).

## 3. Coûts LLM réalistes

Mesuré sur ce type de missions avec Opus 5 (5 $/25 $ par M tokens) et Sonnet 5 (2 $/10 $), cache activé :

| Mission | Modèle | Fréquence | Coût typique |
|---|---|---|---|
| veille | Sonnet 5 | 1/j | 0,30–0,80 $ |
| competitor_watch | Sonnet 5 | 1/j | 0,40–1,00 $ |
| seo_daily (+ codeur) | Opus 5 | 1/j | 1,50–3,50 $ |
| inbox_calendar | Sonnet 5 | 3/j ouvrés | 0,10–0,30 $ chacun |
| iptv_comparator | Opus 5 | 2/sem | 2–5 $ |
| site_audit | Opus 5 | 1/sem | 2–4 $ |
| repo_maintenance | Opus 5 | 1/sem | 1–4 $ |
| reflect | Opus 5 | 1/j | 0,30–1,00 $ |
| rapport du matin | Sonnet 5 | 1/j | 0,05–0,15 $ |
| essaim (10 sous-tâches) | mixte | à la demande | 5–15 $ |

**Ordre de grandeur : 120–250 $/mois** en usage complet, dont ~60 % pour le contenu et le code. Les plafonds `MISSION_BUDGET_USD` et `DAILY_BUDGET_USD` (défaut 25 $/j) sont des coupe-circuits, pas des estimations. Règle la limite mensuelle dans la console Anthropic en plus : c'est la seule qui protège d'un bug.

Leviers si c'est trop : effort `medium` sur seo_daily (−30 %), Sonnet 5 pour le codeur sur les tâches de contenu (−50 % sur cette mission), veille 3×/semaine.

Hors LLM : VPS 5–25 €, X API ~100 $ (optionnel), Tavily 0–30 $, Vercel 0–20 $.

## 4. Fonctionnement continu

- **Redémarrage** : `restart: unless-stopped` sur chaque service + `manzi.service` (systemd) qui relance `docker compose up -d` au boot.
- **Deux instances simultanées impossibles** : verrous `pg_try_advisory_lock` par mission ; un tick pendant qu'une mission tourne est ignoré et journalisé.
- **Healthcheck** : `GET http://127.0.0.1:8787/healthz` (dépense du jour, MCP connectés, prochaines crons). Branche Uptime Kuma ou un `curl` cron qui t'envoie un Telegram si ça ne répond plus.
- **Fuseau** : `TZ=Europe/Paris` dans `.env` ; les crons sont évaluées dans ce fuseau (changement d'heure géré par croner).
- **Logs** : JSON (pino) sur stdout → `docker compose logs -f orchestrator`. Rotation : Docker `json-file` par défaut ; ajoute dans `/etc/docker/daemon.json` `{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"5"}}`.
- **Sauvegardes** : service `backup` = `pg_dump` gzip quotidien dans `./backups`, rotation 14 jours. Copie hors machine : `rclone sync ./backups remote:manzi-backups` en cron. Restauration : `bash deploy/restore.sh backups/manzi-YYYY-MM-DD.sql.gz`.
- **Mises à jour** : `git pull && docker compose up -d --build`. Les migrations sont idempotentes et s'appliquent au boot.

## 5. « Sans limite » : ce qui limite vraiment

Il n'existe pas d'exécution sans limite ; voici les vraies bornes et comment les gérer.

| Limite | Réalité | Parade |
|---|---|---|
| Débit API Anthropic | tokens/minute par tier d'organisation ; un essaim de 10 agents peut le saturer | le SDK retente (backoff) ; `SWARM_CONCURRENCY` ; demander un tier supérieur dans la console |
| Contexte | 1 M tokens sur Opus 5 / Sonnet 5, mais coût proportionnel | compaction serveur activée ; missions courtes et ciblées |
| Argent | la seule limite qui fait vraiment mal | plafonds par mission / jour + limite console |
| Sites cibles | anti-bot, quotas, CGU | respecter robots.txt, cadence faible, API officielles (X), pas de contournement |
| Sandbox | RAM/CPU bornés volontairement | pool de sandboxes pour l'essaim ; VPS plus gros |
| Anthropic « Managed Agents » | alternative hébergée (boucle + sandbox chez Anthropic, déploiements planifiés) | si tu ne veux pas gérer de VPS : même code d'outils, moins d'infra, mais moins de contrôle sur le sandbox |

## 6. Sécurité du VPS (checklist)

- SSH par clé uniquement, `PermitRootLogin prohibit-password`, fail2ban (fait par `vps-bootstrap.sh`).
- `ufw` : seul le port 22 ouvert. Rien d'autre n'écoute publiquement (l'API est sur 127.0.0.1).
- Jarvis se connecte via tunnel SSH : `ssh -N -L 8787:127.0.0.1:8787 manzi@vps`.
- `.env` en `chmod 600`, `secrets/` en `700`, jamais dans git (`.gitignore`).
- Rotation trimestrielle des tokens GitHub/Vercel (dates d'expiration dans le calendrier : la mission `inbox_calendar` te le rappellera).
- Mises à jour de sécurité automatiques (`unattended-upgrades`).

## 7. Vérifier que tout marche (10 minutes)

```bash
docker compose ps                                              # tous "healthy"/"running"
curl -s http://127.0.0.1:8787/healthz | jq                     # mcp: github, gmail…
docker compose exec orchestrator node dist/cli.js veille       # 1–3 min, ~0,50 $
docker compose exec orchestrator node dist/cli.js report       # rapport reçu sur Telegram/Gmail
docker compose exec orchestrator node dist/cli.js swarm "Audite 3 pages du site et propose 5 correctifs priorisés"
docker compose exec db psql -U manzi -c "select mission,status,usd from episodes order by id desc limit 5"
```

Action → How → Metric : lance `install.sh` aujourd'hui → renseigne 3 clés (Anthropic, GitHub, Telegram) → demain 07:30 tu as ton premier rapport ; à J+7, `_metrics.md` montre un taux de succès ≥ 80 % par mission, sinon corrige les cahiers des charges avant d'ajouter des capacités.
