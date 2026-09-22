#!/usr/bin/env bash
# Branche le webhook WhatsApp : démarre le tunnel, attend son adresse, puis
# déclare cette adresse à Meta par l'API. À lancer sur le serveur.
#
#   bash deploy/whatsapp-up.sh            # démarre (ou redémarre) puis déclare
#   bash deploy/whatsapp-up.sh --keep     # ne recrée rien : vérifie et redéclare
#
# `--keep` existe pour la surveillance périodique : recréer le tunnel à chaque
# passage lui ferait tirer une nouvelle adresse, donc provoquerait exactement
# la panne qu'on surveille.
#
# Avec WHATSAPP_APP_ID et WHATSAPP_WABA_ID dans le .env, plus rien n'est à
# cliquer : le script enregistre lui-même l'URL de rappel, le jeton de
# vérification et l'abonnement au champ « messages ». C'est ce qui rend le
# tunnel « quick » utilisable au quotidien — son adresse change à chaque
# redémarrage, et chaque exécution de ce script la redéclare.
# Sans ces deux identifiants, le script retombe sur l'ancien comportement :
# il imprime les valeurs à recopier à la main.
set -euo pipefail

KEEP=0
for a in "$@"; do case "$a" in --keep) KEEP=1 ;; *) printf 'option inconnue: %s\n' "$a" >&2; exit 2 ;; esac; done

DIR="${MANZI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$DIR"

say()  { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }
val()  { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '"\r'; }

[ -f .env ] || die "pas de .env dans $DIR"

# Un \r de fin de ligne Windows rend chaque valeur fausse sans le montrer.
if grep -q $'\r' .env; then sed -i 's/\r$//' .env; say "fins de ligne du .env converties en LF"; fi

[ "$(val WHATSAPP_PROVIDER)" = "meta" ] || die "WHATSAPP_PROVIDER doit valoir 'meta' dans .env"

# Le secret d'application signe chaque message entrant. Sans lui, le serveur
# rejette tout : c'est ce qui empêche un inconnu de faire parler le bot.
for k in WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_ACCESS_TOKEN; do
  [ -n "$(val "$k")" ] || die "$k manquant dans .env — sans lui le webhook ne peut pas fonctionner"
done

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.eco.yml)
if [ -n "$(val CLOUDFLARE_TUNNEL_TOKEN)" ]; then
  SERVICE=tunnel; COMPOSE+=(--profile tunnel)
else
  SERVICE=tunnel-quick; COMPOSE+=(--profile tunnel-quick)
fi

if [ $KEEP = 1 ]; then
  say "vérification (aucun conteneur recréé)"
  "${COMPOSE[@]}" up -d orchestrator "$SERVICE" >/dev/null
else
  say "démarrage ($SERVICE)"
  "${COMPOSE[@]}" up -d --force-recreate orchestrator "$SERVICE"
fi

PUBLIC=""
if [ "$SERVICE" = tunnel-quick ]; then
  say "attente de l'adresse publique (jusqu'à 60 s)"
  for _ in $(seq 1 30); do
    PUBLIC=$("${COMPOSE[@]}" logs --no-color "$SERVICE" 2>/dev/null \
      | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
    [ -n "$PUBLIC" ] && break
    sleep 2
  done
  [ -n "$PUBLIC" ] || die "adresse introuvable — voir: ${COMPOSE[*]} logs $SERVICE"
else
  # C'est le TUNNEL qui fait autorité, pas le .env. Cloudflare lui envoie sa
  # configuration au démarrage et cloudflared la journalise : l'adresse lue
  # là est celle qui répond réellement. Une PUBLIC_URL saisie à la main est
  # une hypothèse — et une hypothèse fausse ne se voit qu'au moment où un
  # message n'arrive pas. Deux fois cette nuit, c'était un exemple de la
  # documentation recopié tel quel.
  PUBLIC=$(val PUBLIC_URL)
  say "lecture du nom d'hôte dans la configuration reçue par le tunnel"
  HOST=""
  for _ in $(seq 1 15); do
    HOST=$("${COMPOSE[@]}" logs --no-color "$SERVICE" 2>/dev/null \
      | tr -d '\\' | grep -oE '"hostname":"[^"]+"' | cut -d'"' -f4 | grep -v '^$' | tail -1 || true)
    [ -n "$HOST" ] && break
    sleep 2
  done

  if [ -n "$HOST" ]; then
    if [ "$PUBLIC" != "https://$HOST" ]; then
      [ -n "$PUBLIC" ] && say "le .env dit « $PUBLIC », le tunnel sert « $HOST » — on garde celle du tunnel"
      PUBLIC="https://$HOST"
      bash "$DIR/deploy/set-env.sh" "PUBLIC_URL=$PUBLIC" >/dev/null
      say "PUBLIC_URL corrigée : $PUBLIC"
    else
      say "adresse confirmée : $PUBLIC"
    fi
  elif [ -z "$PUBLIC" ]; then
    die "aucun nom d'hôte dans les journaux du tunnel, et PUBLIC_URL est vide.
  Lis l'adresse sur dash.cloudflare.com → Zero Trust → Networks → Tunnels →
  ton tunnel → onglet « Public Hostname », puis :
      bash deploy/set-env.sh PUBLIC_URL=https://CE-QUE-TU-AS-LU
  (l'adresse nue : pas de chevrons, pas de guillemets, pas mon exemple)"
  else
    say "journaux du tunnel muets — on s'en tient à PUBLIC_URL du .env ($PUBLIC)"
  fi
fi

say "santé de l'orchestrateur"
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break; sleep 3; done
# Renvoyer l'utilisateur vers `logs` coûte un aller-retour à chaque panne, et
# la cause est toujours dans ces quelques lignes. On les montre ici.
if ! curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
  printf '\n\033[1;31m--- l'"'"'orchestrateur ne répond pas. Ses 40 dernières lignes : ---\033[0m\n' >&2
  "${COMPOSE[@]}" logs --no-color --tail 40 orchestrator >&2 2>/dev/null || true
  printf '\n' >&2
  die "orchestrateur injoignable sur http://127.0.0.1:8787 (voir ci-dessus)"
fi

CALLBACK="$PUBLIC/whatsapp/webhook"
VERIFY=$(val WHATSAPP_VERIFY_TOKEN)
APP_ID=$(val WHATSAPP_APP_ID)
WABA_ID=$(val WHATSAPP_WABA_ID)
GRAPH="https://graph.facebook.com/v21.0"

# On rejoue ici, à l'identique, la vérification que Meta va faire : même URL,
# même jeton, même défi. Meta, lui, ne répond que « URL de rappel non valide »,
# sans distinguer un tunnel qui ne route pas d'un jeton qui ne correspond pas.
say "vérification du webhook depuis l'extérieur"
ECHO=""
for _ in $(seq 1 20); do
  ECHO=$(curl -fsS --max-time 10 -G "$CALLBACK" \
           --data-urlencode "hub.mode=subscribe" \
           --data-urlencode "hub.verify_token=$VERIFY" \
           --data-urlencode "hub.challenge=manzi-ping" 2>/dev/null || true)
  [ "$ECHO" = "manzi-ping" ] && break
  sleep 3
done
[ "$ECHO" = "manzi-ping" ] || die "$CALLBACK ne renvoie pas le défi (reçu: '${ECHO:-rien}').
  Soit le tunnel ne route pas   : ${COMPOSE[*]} logs $SERVICE
  Soit WHATSAPP_VERIFY_TOKEN du .env diffère de celui que lit l'orchestrateur :
                                 ${COMPOSE[*]} up -d --force-recreate orchestrator"

# Meta répond `{"success":true}` aux deux appels ci-dessous, et un objet
# `error` détaillé sinon. On garde le corps de la réponse : c'est la seule
# chose qui dit *pourquoi* l'enregistrement a échoué.
graph_ok() { case "$1" in *'"success":true'* | *'"success": true'*) return 0 ;; *) return 1 ;; esac; }

if [ -n "$APP_ID" ] && [ -n "$WABA_ID" ]; then
  # Le jeton d'application (`app_id|app_secret`) suffit pour déclarer le
  # webhook, et évite de faire dépendre cette étape du jeton utilisateur.
  say "déclaration de l'URL de rappel auprès de Meta"
  R=$(curl -sS --max-time 30 -X POST "$GRAPH/$APP_ID/subscriptions" \
        --data-urlencode "object=whatsapp_business_account" \
        --data-urlencode "callback_url=$CALLBACK" \
        --data-urlencode "verify_token=$VERIFY" \
        --data-urlencode "fields=messages" \
        --data-urlencode "access_token=$APP_ID|$(val WHATSAPP_APP_SECRET)" || true)
  graph_ok "$R" || die "Meta a refusé l'URL de rappel : $R"

  # Déclarer le webhook ne suffit pas : le compte WhatsApp doit encore être
  # abonné à l'application, sinon les messages entrants ne partent nulle part.
  # Cet appel-là exige le jeton permanent (scope whatsapp_business_management).
  say "abonnement du compte WhatsApp à l'application"
  R=$(curl -sS --max-time 30 -X POST "$GRAPH/$WABA_ID/subscribed_apps" \
        -H "Authorization: Bearer $(val WHATSAPP_ACCESS_TOKEN)" || true)
  graph_ok "$R" || die "abonnement refusé : $R"

  cat <<EOF

────────────────────────────────────────────────────────────────
WEBHOOK EN PLACE — rien à cliquer dans Meta

  Callback URL  :  $CALLBACK
  Champ abonné  :  messages
  Compte WhatsApp $WABA_ID abonné à l'app $APP_ID
────────────────────────────────────────────────────────────────

Écris « salut » sur WhatsApp au numéro du bot : il doit répondre.
EOF
else
  cat <<EOF

────────────────────────────────────────────────────────────────
À RECOPIER DANS META
  developers.facebook.com → ton app → WhatsApp → Configuration

  Callback URL  :  $CALLBACK
  Verify token  :  $VERIFY

  Puis « Vérifier et enregistrer », et abonne-toi au champ « messages ».

  (Renseigne WHATSAPP_APP_ID et WHATSAPP_WABA_ID dans le .env et ce
   script fera ces deux étapes tout seul, à chaque exécution.)
────────────────────────────────────────────────────────────────
EOF
fi

cat <<EOF

Si rien n'arrive, regarde ce qui entre :
  ${COMPOSE[*]} logs -f orchestrator | grep -i whatsapp
EOF

if [ "$SERVICE" = tunnel-quick ]; then
  if [ -n "$APP_ID" ] && [ -n "$WABA_ID" ]; then
    cat <<'EOF'

Cette adresse est temporaire : elle change à chaque redémarrage du tunnel.
Relancer ce script suffit alors à la redéclarer à Meta. Pour une adresse qui
ne bouge pas, crée un tunnel nommé (Cloudflare Zero Trust, domaine requis) et
mets son jeton dans CLOUDFLARE_TUNNEL_TOKEN — ce script basculera dessus seul.
EOF
  else
    cat <<'EOF'

Cette adresse est temporaire : elle change à chaque redémarrage du tunnel,
et le webhook Meta est alors à refaire à la main. Pour une adresse fixe, crée
un tunnel nommé (Cloudflare Zero Trust, domaine requis) et mets son jeton dans
CLOUDFLARE_TUNNEL_TOKEN — ce script basculera dessus tout seul.
EOF
  fi
fi
