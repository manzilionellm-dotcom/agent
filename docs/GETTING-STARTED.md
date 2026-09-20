# Cloner et lancer Manzi Junior depuis zéro

Licence MIT : tu peux lire, modifier, forker, déployer chaque ligne sans demander à personne. Ce guide part d'un compte GitHub vide et arrive à un bot qui te répond sur WhatsApp.

## 0. Ce que « open source et auto-géré » veut dire ici (vérités)

- **Le code** est entièrement à toi (MIT), sans télémétrie, sans mise à jour silencieuse : rien ne se met à jour tant que tu ne lances pas `git pull`. Le service systemd relance la stack au redémarrage, il ne télécharge rien.
- **Le comportement** est visible : `AUTONOMY_MODE=manual` (défaut) → rien ne tourne sans ton ordre ou un planning que tu as ordonné (`GET /schedules`, « montre le planning » sur WhatsApp). Les playbooks que l'agent s'écrit sont lisibles (« montre les playbooks ») et ne changent que quand tu ordonnes une réflexion. Toute modification de son propre code passe par une pull request que tu fusionnes ou non.
- **Les services externes** restent des services externes : un modèle de langage (DeepSeek, Anthropic, ou un modèle ouvert que tu héberges), WhatsApp (Meta), GitHub, Vercel. Ils sont tous remplaçables par configuration :

| Fermé | Alternative ouverte / auto-hébergée | Comment |
|---|---|---|
| DeepSeek / Anthropic | Qwen3, DeepSeek, Llama via **Ollama** ou **vLLM** sur ta machine (GPU 16 Go+ pour un modèle utile) | `LLM_PROVIDER=openai_compat`, `OPENAI_COMPAT_BASE_URL=http://<ta-machine>:11434/v1` |
| WhatsApp (Meta) | Telegram (déjà supporté en secours), Matrix/Signal via passerelle | `WHATSAPP_PROVIDER=none`, `TELEGRAM_*` |
| GitHub | Gitea/Forgejo auto-hébergé | `GITHUB_REPO` + URL du remote dans `tools/git.ts` (une ligne) |
| Vercel | Caddy/Coolify sur le VPS | retirer `VERCEL_*`, déployer par `git pull` sur le serveur |
| Tavily/SerpAPI | SearXNG auto-hébergé | ajouter un outil dans `tools/search.ts` (30 lignes) |

FAIT : un modèle ouvert de qualité « agent » (≥ 30 B paramètres) ne tourne pas sur un VPS à 4 €. Zéro dépendance fermée = une machine à toi avec GPU, ou accepter un fournisseur d'API.

## 1. Forker

1. GitHub → `manzilionellm-dotcom/agent` → **Fork** (ou crée un dépôt vide et pousse ce code). Rends-le public si tu le souhaites : Settings → Danger zone → Change visibility. Aucun secret n'est dans le dépôt (`.env`, `secrets/`, `agent/mcp.json` sont ignorés par git).
2. Crée un **fine-grained token** limité à ce dépôt (Contents RW, Pull requests RW, Issues RW, Metadata R) : c'est `GITHUB_TOKEN`.

## 2. Comptes et clés (30 minutes)

| Clé | Où | Coût |
|---|---|---|
| `OPENAI_COMPAT_API_KEY` (DeepSeek) | platform.deepseek.com → API keys | usage, ~2–6 €/mois ici |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys (règle une limite mensuelle) | usage, ~15–30 €/mois ici |
| `TAVILY_API_KEY` | app.tavily.com | gratuit 1 000 crédits/mois |
| WhatsApp (4 valeurs) | voir `docs/ECO.md` §4 | gratuit en réponse |
| `CLOUDFLARE_TUNNEL_TOKEN` | Cloudflare Zero Trust → Tunnels | gratuit |
| `GITHUB_TOKEN` | ci-dessus | gratuit |
| `VERCEL_TOKEN` (optionnel) | vercel.com → Tokens | gratuit (Hobby) |

## 3. Le serveur (10 minutes)

Hetzner Cloud → CX22 (Debian 12, 4 Go, ~4 €). Ajoute ta clé SSH à la création. Puis, en root :

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/<toi>/agent/main/deploy/vps-bootstrap.sh) manzi https://github.com/<toi>/agent.git
```

Cela installe Docker, crée l'utilisateur `manzi`, ferme tout sauf SSH, active les mises à jour de sécurité, clone ton fork dans `/home/manzi/manzi-junior`, et installe le service systemd.

## 4. Configurer et lancer (5 minutes)

```bash
su - manzi && cd manzi-junior
nano .env          # colle tes clés (le fichier est déjà en profil éco)
./install.sh --eco # construit, démarre, vérifie ; s'arrête en listant ce qui manque
```

Premier build : 5–10 minutes. Ensuite :

```bash
curl -s http://127.0.0.1:8787/healthz | jq
docker compose exec orchestrator node dist/cli.js veille    # test direct, ~0,20 $
```

Sur WhatsApp, écris « salut » au numéro du bot.

## 5. Donner des ordres

Tout passe par WhatsApp (ou Jarvis, ou `POST /chat`). Exemples : « lance la veille », « lance l'audit du site », « planifie la veille tous les jours à 5h et le rapport à 7h30 », « lance un essaim : … », « montre le planning », « montre les playbooks », « lance la réflexion » (met à jour les playbooks à partir des missions passées). Rien d'autre ne se produit.

Pour passer en pilotage automatique un jour : `AUTONOMY_MODE=scheduled` dans `.env`, redémarrer. C'est ton choix, jamais le sien.

## 6. Mettre à jour, sauvegarder, restaurer

```bash
git pull --ff-only && ./install.sh --eco          # mise à jour explicite (rien d'automatique)
ls backups/                                       # dump Postgres quotidien, 14 jours
bash deploy/restore.sh backups/manzi-2026-09-20.sql.gz
```

## 7. Modifier le bot

- Une mission = une entrée dans `agent/src/missions/index.ts` (cahier des charges, outils, budget).
- Un outil = un `betaZodTool` dans `agent/src/tools/`.
- Un rôle d'essaim = une entrée dans `agent/src/swarm/roles.ts`.
- Le prompt système = `agent/src/prompts.ts` ; le chat = `agent/src/channels/chat.ts`.
- `cd agent && npm install && npm run typecheck` avant de committer ; `docker compose up -d --build` pour déployer.

Pull requests bienvenues sur ton fork ou l'original ; la licence MIT ne t'oblige à rien.
