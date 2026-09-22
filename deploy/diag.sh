#!/usr/bin/env bash
# État réel du système. Aucun secret affiché — seulement « défini » ou « vide ».
#
#   ssh manzi@50.21.190.19 'cd manzi-junior && bash deploy/diag.sh'
#
# Ce script existe parce que la question « pourquoi ça ne marche pas » se
# répond en regardant cinq endroits, et que les taper un par un à travers ssh
# depuis PowerShell coûte plus cher que de les écrire ici une fois.

set -uo pipefail
cd "$(dirname "$0")/.."

t() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
val() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r'; }
etat() { local v; v=$(val "$1"); [ -n "$v" ] && printf '  %-28s %s\n' "$1" "${2:-défini (${#v} car.)}" || printf '  %-28s \033[1;31mVIDE\033[0m\n' "$1"; }

COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)
CTUN=("${COMPOSE[@]}" --profile tunnel --profile tunnel-quick)

t "Configuration (.env)"
# Les adresses ne sont pas des secrets : on les montre en clair, elles sont
# précisément ce qu'on vient vérifier. Les clés, jamais.
etat PUBLIC_URL "$(val PUBLIC_URL)"
etat CLOUDFLARE_TUNNEL_TOKEN
etat VAULT_KEY
etat ORCHESTRATOR_TOKEN
etat WHATSAPP_TOKEN
etat WHATSAPP_PHONE_NUMBER_ID "$(val WHATSAPP_PHONE_NUMBER_ID)"
etat GOOGLE_REFRESH_TOKEN
etat MISTRAL_API_KEY
etat ANTHROPIC_API_KEY
etat DEEPSEEK_API_KEY

t "Conteneurs"
"${CTUN[@]}" ps --format '  {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null || "${CTUN[@]}" ps

t "Tunnel — nom d'hôte servi (lu dans sa configuration reçue)"
HOST=$("${CTUN[@]}" logs --no-color tunnel tunnel-quick 2>/dev/null \
  | tr -d '\\' | grep -oE '"hostname":"[^"]+"' | cut -d'"' -f4 | grep -v '^$' | tail -1)
QUICK=$("${CTUN[@]}" logs --no-color tunnel-quick 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
if [ -n "$HOST" ]; then
  printf '  hostname servi : https://%s\n' "$HOST"
  [ "$(val PUBLIC_URL)" = "https://$HOST" ] && printf '  \033[1;32mcohérent avec PUBLIC_URL\033[0m\n' \
    || printf '  \033[1;31mDÉSACCORD avec PUBLIC_URL — corrige : bash deploy/whatsapp-up.sh\033[0m\n'
elif [ -n "$QUICK" ]; then
  printf '  tunnel éphémère : %s\n' "$QUICK"
else
  printf '  \033[1;31maucun nom d hôte dans les journaux du tunnel\033[0m\n'
  printf '  dernières lignes :\n'
  "${CTUN[@]}" logs --no-color --tail 12 tunnel tunnel-quick 2>&1 | sed 's/^/    | /'
fi

t "Orchestrateur"
if curl -fsS http://127.0.0.1:8787/healthz 2>/dev/null | head -c 400; then echo; else
  printf '  \033[1;31mne répond pas sur /healthz\033[0m\n'
  "${COMPOSE[@]}" logs --no-color --tail 20 orchestrator 2>&1 | sed 's/^/    | /'
fi

t "Webhook déclaré chez Meta"
APP=$(val WHATSAPP_APP_ID); SEC=$(val WHATSAPP_APP_SECRET)
if [ -n "$APP" ] && [ -n "$SEC" ]; then
  curl -fsS "https://graph.facebook.com/v21.0/$APP/subscriptions?access_token=$APP%7C$SEC" 2>/dev/null \
    | tr ',' '\n' | grep -E 'callback_url|active|fields' | sed 's/^/  /' || printf '  interrogation impossible\n'
else
  printf '  WHATSAPP_APP_ID ou WHATSAPP_APP_SECRET absent — vérification impossible\n'
fi

t "Coffre"
N=$("${COMPOSE[@]}" exec -T db psql -qtA -U manzi -d manzi -c 'select count(*) from credentials' 2>/dev/null | tr -d ' \r')
printf '  identifiants enregistrés : %s\n' "${N:-lecture impossible}"

echo
