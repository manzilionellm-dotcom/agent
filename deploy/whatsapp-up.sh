#!/usr/bin/env bash
# Branche le webhook WhatsApp : démarre le tunnel, attend son adresse, et
# imprime les deux valeurs à recopier dans Meta. À lancer sur le serveur.
#
#   bash deploy/whatsapp-up.sh
#
# Ce que ce script ne fait pas : parler à Meta. La configuration du webhook
# se fait à la main dans l'interface — Meta n'expose pas d'API pour ça sans
# vérification d'entreprise. Le script produit donc exactement ce qu'il faut
# coller, plutôt que de décrire où cliquer.
set -euo pipefail

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

say "démarrage ($SERVICE)"
"${COMPOSE[@]}" up -d --force-recreate orchestrator "$SERVICE"

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
  PUBLIC=$(val PUBLIC_URL)
  [ -n "$PUBLIC" ] || die "PUBLIC_URL manquant dans .env (requis avec un tunnel nommé)"
fi

say "santé de l'orchestrateur"
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break; sleep 3; done

cat <<EOF

────────────────────────────────────────────────────────────────
À RECOPIER DANS META
  developers.facebook.com → ton app → WhatsApp → Configuration

  Callback URL  :  $PUBLIC/whatsapp/webhook
  Verify token  :  $(val WHATSAPP_VERIFY_TOKEN)

  Puis « Vérifier et enregistrer », et abonne-toi au champ « messages ».
────────────────────────────────────────────────────────────────

Ensuite, écris sur WhatsApp au numéro du bot : il doit répondre.
Si rien n'arrive, regarde ce qui entre :
  ${COMPOSE[*]} logs -f orchestrator | grep -i whatsapp
EOF

if [ "$SERVICE" = tunnel-quick ]; then
  cat <<'EOF'

Cette adresse est temporaire : elle change à chaque redémarrage du tunnel,
et le webhook Meta est alors à refaire. Pour une adresse fixe, crée un tunnel
nommé (Cloudflare Zero Trust, domaine requis) et mets son jeton dans
CLOUDFLARE_TUNNEL_TOKEN — ce script basculera dessus tout seul.
EOF
fi
