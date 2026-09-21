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

Pour **tout** remettre d'aplomb d'un coup — code, images, pont Chrome, webhook WhatsApp déclaré à Meta, surveillance du webhook — une seule commande, en root :

```bash
cd ~/manzi-junior && sudo -u manzi -H git pull --ff-only && bash deploy/finish.sh
```

Chaque étape est idempotente, et une étape indépendante qui échoue n'arrête pas les suivantes : le récapitulatif final dit ce qui est en place et ce qui ne l'est pas, plutôt que de laisser le reste dans un état inconnu.

`install.sh --eco` = `docker compose -f docker-compose.yml -f docker-compose.eco.yml up -d --build`, plus la vérification des clés (il s'arrête et liste ce qui manque). Il complète aussi `POSTGRES_PASSWORD`, `ORCHESTRATOR_TOKEN` et `DOCKER_GID` s'ils sont vides ou encore sur le gabarit, y compris dans un `.env` écrit à la main, et passe le fichier en `chmod 600`. Les migrations (tables `chat_messages`, `schedules`) s'appliquent au démarrage. Aucune donnée n'est perdue (volumes conservés).

Depuis zéro sur un CX22 (dépôt privé) : voir les 6 commandes de `docs/GETTING-STARTED.md` §3, ou `bash deploy/vps-bootstrap.sh manzi https://github.com/<toi>/agent.git "$GITHUB_TOKEN"` puis `./install.sh --eco`.

## 4. WhatsApp : mise en place (20 minutes)

### Option A — Meta Cloud API (recommandée : gratuite en réponse)

Le **numéro de test** que Meta prête suffit : il écrit à 5 destinataires vérifiés, sans vérification d'entreprise et sans frais. Pour un agent qui parle à son propriétaire, c'est un destinataire sur cinq. Un numéro à toi n'a de sens que pour écrire à des clients.

1. developers.facebook.com → Mes apps → Créer une app → type « Business » → ajouter le produit **WhatsApp**. Meta impose un portefeuille business ; le nom doit correspondre au nom public exact de l'entreprise, majuscule comprise, sinon il est refusé.
2. Onglet *API Setup* : note le **Phone number ID** (`WHATSAPP_PHONE_NUMBER_ID`). Le jeton affiché à côté expire en 24 h — utile pour un premier essai, inutilisable ensuite.
3. **Jeton permanent** : Business Settings → Utilisateurs système → créer `manzi-bot` (Administrateur) → lui affecter l'app **et** le compte WhatsApp en contrôle total → Générer un jeton, expiration *Jamais*, permissions `whatsapp_business_messaging` et `whatsapp_business_management` → `WHATSAPP_ACCESS_TOKEN`. Sans l'affectation des deux actifs, le jeton est créé mais n'a droit à rien.
4. Paramètres de l'app → *Paramètres de base* → **Clé secrète** → `WHATSAPP_APP_SECRET`, et **Identifiant de l'application** → `WHATSAPP_APP_ID`. **Obligatoire** : le serveur rejette tout message entrant non signé, c'est ce qui empêche un inconnu de faire parler le bot.
5. Choisis une chaîne aléatoire → `WHATSAPP_VERIFY_TOKEN`. Note aussi le **WABA ID** (*WhatsApp* → *Configuration de l'API*, sous le Phone number ID) → `WHATSAPP_WABA_ID` : c'est ce qui permet à l'étape 9 de se passer de l'interface.
6. **Enregistrer le numéro auprès de l'API** — l'étape que rien ne signale, et sans laquelle tout envoi échoue sur `(#133010) Account not registered` :
   ```bash
   curl -X POST "https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/register" \
     -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
     -d '{"messaging_product":"whatsapp","pin":"481529"}'
   ```
   Réponse attendue : `{"success":true}`. **Note le PIN** : Meta le redemande à toute réactivation du numéro, y compris après une migration de serveur.
7. Ajoute ton numéro comme destinataire de test (*API Setup* → section « Envoyer et recevoir »). Meta envoie un code par WhatsApp, à saisir. Puis `WHATSAPP_ALLOWED_NUMBERS=46764169242` (sans `+`).
8. **Vérifier la chaîne avant d'aller plus loin** — le modèle `hello_world` existe par défaut sur tout compte neuf :
   ```bash
   curl -X POST "https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages" \
     -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
     -d '{"messaging_product":"whatsapp","to":"<TON_NUMERO>","type":"template","template":{"name":"hello_world","language":{"code":"en_US"}}}'
   ```
   Si le téléphone sonne, le jeton, le numéro et l'autorisation sont bons — trois causes d'échec éliminées d'un coup. Tant que tu n'as pas répondu, Meta n'autorise que des modèles préapprouvés ; ta première réponse ouvre une fenêtre de 24 h pendant laquelle le bot écrit librement.
9. **Le webhook, en une commande** — elle démarre le tunnel, attend son adresse, rejoue la vérification que Meta va faire, puis déclare l'adresse à Meta et abonne le compte WhatsApp à l'app :
   ```bash
   bash deploy/whatsapp-up.sh
   ```
   Avec `WHATSAPP_APP_ID` et `WHATSAPP_WABA_ID`, il n'y a **rien à cliquer** : le script fait les deux appels (`POST /{app-id}/subscriptions` avec le jeton d'application `app_id|app_secret`, puis `POST /{waba-id}/subscribed_apps` avec le jeton permanent). Sans ces deux identifiants, il retombe sur l'ancien comportement et imprime les valeurs à recopier.

   Les deux appels sont nécessaires, et c'est le piège : déclarer l'URL de rappel ne suffit pas. Sans `subscribed_apps`, Meta vérifie le webhook, répond `success`, et les messages entrants ne partent nulle part — aucune erreur, aucun journal, juste un bot muet.

   Avec `CLOUDFLARE_TUNNEL_TOKEN` (tunnel nommé, domaine requis) l'adresse est fixe. Sans jeton, un tunnel *quick* en tire une au hasard en `*.trycloudflare.com` : rien à acheter, mais elle change à chaque redémarrage — relancer cette commande suffit alors à redéclarer la nouvelle adresse.

10. **Rendre le webhook auto-réparable** (tunnel *quick* surtout) :
    ```bash
    sudo bash deploy/whatsapp-watch-install.sh
    ```
    Le tunnel *quick* retire une adresse au hasard à chaque redémarrage — du serveur, ou du seul conteneur `cloudflared`. Meta continue d'appeler l'ancienne, et **le bot devient sourd sans le dire** : aucune erreur, aucun journal, on ne s'en aperçoit qu'en lui écrivant. Le minuteur relance `whatsapp-up.sh --keep` au démarrage puis toutes les dix minutes ; l'appel est idempotent, donc sans effet tant que rien n'a bougé. Fenêtre de surdité ramenée à dix minutes.

    `journalctl -u manzi-whatsapp.service -n 40` pour voir ses passages.
11. **Modèle pour les envois hors fenêtre 24 h** (rapport du matin, alertes si tu n'as rien écrit la veille) : WhatsApp Manager → Message templates → créer `manzi_daily_report`, catégorie *Utility*, langue `fr`, corps : `Rapport Manzi Junior : {{1}}`. Approbation en quelques minutes à quelques heures. Coût : quelques centimes par envoi ; les réponses dans les 24 h suivant ton message sont gratuites.

### Ce que le numéro de test ne fait pas

Trois plafonds, à connaître avant de construire dessus plutôt qu'après :

- Le numéro de test prêté par Meta **expire** (de l'ordre de 90 jours) et n'écrit qu'aux **5 destinataires déclarés**. Pour un agent qui parle à son propriétaire, c'est sans effet ; pour écrire à des clients, il faut passer à *Configuration de la production* avec un numéro à soi.
- Ce numéro ne doit **pas déjà être actif sur WhatsApp** (application normale ou Business) : l'enregistrer sur la Cloud API détache le compte existant, et les conversations sont perdues. Prends un numéro neuf.
- Sans **vérification d'entreprise** : 250 conversations *business-initiated* par 24 h. Les réponses dans la fenêtre de 24 h n'y comptent pas. Suffisant pour un agent personnel, bloquant dès qu'il y a des clients.

### Option B — Twilio

`WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM=whatsapp:+1415...` (sandbox Twilio pour tester, numéro dédié en prod), `PUBLIC_URL` obligatoire (signature). Webhook : Messaging → *When a message comes in* → `https://…/whatsapp/webhook` (POST). Coût : Meta + ~0,005 $ par message Twilio.

### Ce que tu peux dire

« salut », « qu'est-ce qui s'est passé cette nuit ? », « lance la veille », « lance l'audit du site », « lance un essaim : relève les tarifs des 10 fournisseurs et mets à jour le comparateur », « planifie la veille tous les jours à 5h », « planifie le rapport à 7h30 en semaine », « déplanifie la veille », « montre le planning », « montre les playbooks », « combien on a dépensé aujourd'hui ? », « retiens que je préfère les rapports courts ». Quand une mission veut faire une action irréversible (envoyer un e-mail, créer une issue), tu reçois « 🔐 Approbation requise … réponds OUI-K7Q2 » : réponds `OUI-K7Q2` ou `NON-K7Q2` ; sans réponse en 10 min, l'action reste en dry-run et figure dans le rapport.

Chaque message coûte 0,001 à 0,01 $ (DeepSeek). Les tâches longues répondent « lancé » puis un second message à la fin.

## 5. Ton Chrome piloté par le bot (tunnel)

Deux commandes, une par machine.

**Sur le serveur, une fois :**
```bash
sudo bash deploy/chrome-bridge-server.sh
```
Il demande au sandbox à quelle adresse se résout `host.docker.internal`, met `BROWSER_CDP_URL` à `http://<cette-IP>:9222`, s'assure que sshd accepte `GatewayPorts clientspecified`, ferme le port 9222 côté ufw, et redémarre l'orchestrateur.

**Sur ton PC Windows, à chaque session de travail :**
```powershell
$env:MANZI_HOST='manzi@<ip-du-serveur>'; $env:MANZI_GW='<IP affichée ci-dessus>'; .\chrome-bridge.ps1
```
Il ouvre le Chrome du bot, recopie ton profil au premier lancement (donc tes sessions), et maintient le tunnel inverse avec reconnexion automatique. Fenêtre fermée = le bot retombe sur son Chromium de sandbox (profil persistant dans `/work/browser-profile`).

Trois détails qui coûtent une soirée chacun si on les ignore :

- **Chrome ≥ 136 refuse `--remote-debugging-port` sur le profil par défaut.** Volontaire, non contournable. D'où le profil dédié — et la copie du profil existant, qui rend cette contrainte indolore.
- **`BROWSER_CDP_URL` doit porter une IP, pas `host.docker.internal`.** Chrome rejette toute requête de débogage dont l'en-tête `Host` n'est ni `localhost` ni une adresse IP, et le message d'erreur ne dit pas ça.
- **Le `ssh -R` doit écouter sur la passerelle Docker, jamais sur `0.0.0.0`.** Un `-R` par défaut n'écoute que sur la boucle locale du serveur, où aucun conteneur ne va ; `0.0.0.0` marcherait, et publierait le pilotage de ton navigateur authentifié sur Internet.

Risque, une ligne : en mode tunnel, le bot agit dans tes comptes connectés — `BROWSER_DENY_DOMAINS` exclut les domaines que tu ne veux pas lui laisser, et le mode manuel existe pour ça.

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
