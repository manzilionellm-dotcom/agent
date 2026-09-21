# Mode économique — 30 à 50 € par mois, WhatsApp en canal principal

Ce document est le « diff » de configuration entre le profil complet (≈250 $/mois) et le profil éco, les variables à changer, et le redéploiement en une commande.

## 1. Ce qui change (résumé du diff)

| Fichier | Avant | Après |
|---|---|---|
| `.env` | Claude Opus 5 partout, X API, Telegram | DeepSeek partout **sauf** missions critiques (Claude Sonnet 5), scraping X gratuit, WhatsApp, budgets serrés, mode manuel |
| `agent/src/llm.ts` | un fournisseur global | `resolveModel(kind)` : `planner`/`worker`/`chat` → `LLM_PROVIDER`, `critical` → `LLM_PROVIDER_CRITICAL` |
| `agent/src/missions/index.ts` | `model: "planner"` | `seo_daily`, `iptv_comparator`, `repo_maintenance` → `model: "critical"` (écrivent + déploient) |
| `agent/src/swarm/roles.ts` | idem | `coder`, `publisher`, `deployer` → `critical` |
| `agent/src/tools/x.ts` | API X v2 (`X_BEARER_TOKEN`, ~100 $/mois) | `x_profile` : syndication → Chromium → Tavily, gratuit, best-effort |
| `agent/src/channels/whatsapp.ts` | — | Meta Cloud API ou Twilio : réception signée, liste blanche, envoi, modèle hors fenêtre 24 h |
| `agent/src/channels/chat.ts` | — | conversation : ordres, missions, essaims, planning, rapport, playbooks |
| `agent/src/scheduler.ts` | crons par défaut toujours actives | `AUTONOMY_MODE=manual` : rien sans ordre ; planning ordonné en base (`schedules`) |
| `agent/src/index.ts` | API locale | + `POST /chat`, `GET|POST /whatsapp/webhook` (signature), `GET /schedules` |
| `agent/src/missions/report.ts`, `tools/notify.ts` | Gmail/Telegram | WhatsApp d'abord, puis Gmail, puis Telegram |
| `docker-compose.eco.yml` | — | limites RAM (Postgres 256 Mo, sandbox 2,2 Go, orchestrateur 512 Mo), concurrence 3, budgets, tunnel Cloudflare |
| `install.sh` | `--swarm`, `--jarvis` | + `--eco` (incompatible avec `--swarm`) |

Rien n'est retiré du code : le profil complet reste disponible en changeant le `.env`.

## 2. Variables d'environnement à changer

```env
# Autonomie : rien sans ordre
AUTONOMY_MODE=manual

# LLM — DeepSeek pour tout…
LLM_PROVIDER=openai_compat
OPENAI_COMPAT_BASE_URL=https://api.deepseek.com/v1
OPENAI_COMPAT_API_KEY=sk-...
MODEL_PLANNER=deepseek-reasoner
MODEL_WORKER=deepseek-chat
MODEL_CHAT=deepseek-chat
MODEL_PRICES=deepseek-reasoner=0.55/2.19,deepseek-chat=0.27/1.10
# …sauf ce qui écrit du code et déploie
LLM_PROVIDER_CRITICAL=anthropic
MODEL_CRITICAL=claude-sonnet-5
MODEL_CODER=claude-sonnet-5
ANTHROPIC_API_KEY=sk-ant-...

# Recherche (remplace web_search/web_fetch de Claude)
TAVILY_API_KEY=tvly-...

# Budgets
MISSION_BUDGET_USD=1.5
DAILY_BUDGET_USD=2.5

# X : plus de X_BEARER_TOKEN. Optionnel :
X_AUTH_TOKEN=

# WhatsApp
WHATSAPP_PROVIDER=meta
WHATSAPP_ALLOWED_NUMBERS=33612345678
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=...
PUBLIC_URL=https://manzi.votre-domaine.fr
CLOUDFLARE_TUNNEL_TOKEN=...

# Navigateur : ton Chrome via tunnel
BROWSER_CDP_URL=http://host.docker.internal:9222
```

Variables supprimées : `X_BEARER_TOKEN`. Variables devenues optionnelles : `TELEGRAM_*` (secours), `REPORT_TO_EMAIL`.

## 3. Redéploiement en une commande

```bash
cd ~/manzi-junior && git pull --ff-only && ./install.sh --eco
```

`install.sh --eco` = `docker compose -f docker-compose.yml -f docker-compose.eco.yml up -d --build`, plus la vérification des clés (il s'arrête et liste ce qui manque). Il complète aussi `POSTGRES_PASSWORD`, `ORCHESTRATOR_TOKEN` et `DOCKER_GID` s'ils sont vides ou encore sur le gabarit, y compris dans un `.env` écrit à la main, et passe le fichier en `chmod 600`. Les migrations (tables `chat_messages`, `schedules`) s'appliquent au démarrage. Aucune donnée n'est perdue (volumes conservés).

Depuis zéro sur un CX22 (dépôt privé) : voir les 6 commandes de `docs/GETTING-STARTED.md` §3, ou `bash deploy/vps-bootstrap.sh manzi https://github.com/<toi>/agent.git "$GITHUB_TOKEN"` puis `./install.sh --eco`.

## 4. WhatsApp : mise en place (20 minutes)

### Option A — Meta Cloud API (recommandée : gratuite en réponse)

1. developers.facebook.com → Mes apps → Créer une app → type « Business » → ajouter le produit **WhatsApp**.
2. Onglet *API Setup* : note **Phone number ID** (`WHATSAPP_PHONE_NUMBER_ID`) et génère un **jeton permanent** via un utilisateur système (Business Settings → System users → Generate token, permissions `whatsapp_business_messaging`, `whatsapp_business_management`) → `WHATSAPP_ACCESS_TOKEN`. Le jeton temporaire de la console expire en 24 h ; ne l'utilise pas.
3. Paramètres de l'app → *Basic* → **App Secret** → `WHATSAPP_APP_SECRET`.
4. Choisis une chaîne aléatoire → `WHATSAPP_VERIFY_TOKEN`.
5. Tunnel Cloudflare (gratuit) : Zero Trust → Networks → Tunnels → Create → *Cloudflared* → copie le token → `CLOUDFLARE_TUNNEL_TOKEN` ; Public hostname : `manzi.<ton-domaine>` → `http://orchestrator:8787`. Pas de domaine ? Le tunnel rapide `cloudflared tunnel --url http://orchestrator:8787` donne une URL `*.trycloudflare.com` qui change à chaque redémarrage — acceptable pour tester, pas pour la prod.
6. Webhook : Configuration → Callback URL `https://manzi.<ton-domaine>/whatsapp/webhook`, Verify token = `WHATSAPP_VERIFY_TOKEN`, abonne-toi au champ **messages**.
7. Ajoute ton numéro comme destinataire de test (ou passe le numéro en production après vérification de l'entreprise). `WHATSAPP_ALLOWED_NUMBERS=336...` (sans +).
8. **Modèle pour les envois hors fenêtre 24 h** (rapport du matin, alertes si tu n'as rien écrit la veille) : WhatsApp Manager → Message templates → créer `manzi_daily_report`, catégorie *Utility*, langue `fr`, corps : `Rapport Manzi Junior : {{1}}`. Approbation en quelques minutes à quelques heures. Coût : quelques centimes par envoi ; les réponses dans les 24 h suivant ton message sont gratuites.

### Option B — Twilio

`WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM=whatsapp:+1415...` (sandbox Twilio pour tester, numéro dédié en prod), `PUBLIC_URL` obligatoire (signature). Webhook : Messaging → *When a message comes in* → `https://…/whatsapp/webhook` (POST). Coût : Meta + ~0,005 $ par message Twilio.

### Ce que tu peux dire

« salut », « qu'est-ce qui s'est passé cette nuit ? », « lance la veille », « lance l'audit du site », « lance un essaim : relève les tarifs des 10 fournisseurs et mets à jour le comparateur », « planifie la veille tous les jours à 5h », « planifie le rapport à 7h30 en semaine », « déplanifie la veille », « montre le planning », « montre les playbooks », « combien on a dépensé aujourd'hui ? », « retiens que je préfère les rapports courts ». Quand une mission veut faire une action irréversible (envoyer un e-mail, créer une issue), tu reçois « 🔐 Approbation requise … réponds OUI-K7Q2 » : réponds `OUI-K7Q2` ou `NON-K7Q2` ; sans réponse en 10 min, l'action reste en dry-run et figure dans le rapport.

Chaque message coûte 0,001 à 0,01 $ (DeepSeek). Les tâches longues répondent « lancé » puis un second message à la fin.

## 5. Ton Chrome piloté par le bot (tunnel)

Sur ton PC :

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-manzi"
# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\chrome-manzi"
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-manzi"

# Tunnel inverse vers le VPS (laisse ouvert)
ssh -N -R 0.0.0.0:9222:127.0.0.1:9222 manzi@<vps>
```

FAIT : Chrome ≥ 136 refuse le débogage distant sur ton profil quotidien ; `--user-data-dir` crée un profil dédié. Connecte-toi une fois aux sites voulus dans ce profil : les sessions persistent. Le VPS a `GatewayPorts clientspecified` (fait par `vps-bootstrap.sh`) et `ufw` bloque le port 9222 depuis l'extérieur. `BROWSER_CDP_URL=http://host.docker.internal:9222` dans `.env`. Tunnel fermé = le bot bascule sur son Chromium de sandbox (profil persistant dans `/work/browser-profile`).

Risque, une ligne : en mode tunnel, le bot agit dans tes comptes connectés ; c'est pour ça que le mode manuel existe.

## 6. Budget mensuel réaliste (profil éco)

| Poste | Montant |
|---|---|
| Hetzner CX22 | ~4 € |
| DeepSeek (veille, concurrents, chat, rapport, audit hebdo) | 2–6 € |
| Claude Sonnet 5 (article quotidien + codeur, comparateur 2×/sem, maintenance) | 15–30 € |
| Tavily | 0 € (1 000 crédits/mois) à 30 $ si tu dépasses |
| WhatsApp (modèles hors fenêtre) | 0–2 € |
| Cloudflare Tunnel, GitHub, Vercel Hobby | 0 € |
| **Total** | **≈ 25–45 €** |

Les deux leviers si tu dépasses : article SEO 3×/semaine au lieu de 7 (−40 % sur le poste Claude) ; `MODEL_CRITICAL=deepseek-chat` pour le contenu et garder Claude uniquement pour `repo_maintenance` (à mesurer : la qualité du build/deploy est ce qui coûte cher quand elle manque).

Ce que le profil éco ne fait plus : essaim à 10 agents simultanés (3 max, un seul sandbox), API X officielle (remplacée par du scraping best-effort), Opus 5.

## 7. Vérifier

```bash
curl -s http://127.0.0.1:8787/healthz | jq '.mode,.whatsapp,.jobs'     # "manual", "meta", []
# WhatsApp → « salut »  → réponse en 3-8 s
# WhatsApp → « planifie la veille tous les jours à 5h » → visible dans GET /schedules
docker compose logs -f orchestrator | grep -E "whatsapp|chat|cron"
```

Action → How → Metric : ce soir `git pull && ./install.sh --eco` ; demain matin envoie « lance la veille » sur WhatsApp ; à J+30, facture LLM < 40 € (console DeepSeek + Anthropic) et `spend` en base cohérent.
