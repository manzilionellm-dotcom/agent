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
  printf '  \033[1;33mtunnel ÉPHÉMÈRE : %s\033[0m\n' "$QUICK"
  printf '  cette adresse change à chaque redémarrage — tout lien déjà envoyé meurt avec elle\n'
  [ -n "$(val CLOUDFLARE_TUNNEL_TOKEN)" ] \
    && printf '  un CLOUDFLARE_TUNNEL_TOKEN existe : le tunnel nommé ne tourne pas → bash deploy/whatsapp-up.sh\n' \
    || printf '  pour une adresse fixe : tunnel nommé dans Cloudflare Zero Trust + CLOUDFLARE_TUNNEL_TOKEN\n' 
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

t "Navigateur du serveur (conteneur desktop)"
if "${COMPOSE[@]}" ps --format '{{.Service}}' 2>/dev/null | grep -qx desktop; then
  VER=$("${COMPOSE[@]}" exec -T desktop curl -fsS --max-time 3 http://127.0.0.1:9222/json/version 2>/dev/null | tr -d '\n' | head -c 150)
  [ -n "$VER" ] && printf '  navigateur       \033[1;32men marche\033[0m : %s\n' "$VER" \
                || printf '  navigateur       \033[1;31mne répond pas\033[0m (il met ~40 s à démarrer)\n'
  ECR=$("${COMPOSE[@]}" exec -T desktop curl -fsS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:6080/ 2>/dev/null)
  [ "$ECR" = 200 ] && printf '  écran (noVNC)    \033[1;32mservi\033[0m\n' || printf '  écran (noVNC)    \033[1;31mHTTP %s\033[0m\n' "${ECR:-aucune réponse}"
  JOINT=$("${COMPOSE[@]}" exec -T orchestrator curl -fsS --max-time 3 -o /dev/null -w '%{http_code}' http://desktop:6080/ 2>/dev/null)
  [ "$JOINT" = 200 ] && printf '  vu par /screen   \033[1;32moui\033[0m\n' || printf '  vu par /screen   \033[1;31mnon (HTTP %s)\033[0m\n' "${JOINT:-aucune}"
  # Par l'IP, jamais par le nom : Chrome rejette un en-tête Host qui n'est ni
  # localhost ni une adresse. Interroger « desktop » annoncerait une panne
  # là où tout marche.
  DIP=$("${COMPOSE[@]}" exec -T sandbox getent hosts desktop 2>/dev/null | awk '{print $1}' | head -1 | tr -d '\r')
  if [ -n "$DIP" ]; then
    PIL=$("${COMPOSE[@]}" exec -T sandbox curl -fsS --max-time 3 "http://$DIP:9223/json/version" 2>/dev/null | head -c 120)
    [ -n "$PIL" ] && printf '  piloté par l agent \033[1;32moui\033[0m (%s)\n' "$DIP" || printf '  piloté par l agent \033[1;31mnon\033[0m (%s ne répond pas sur 9223)\n' "$DIP"
  else
    printf '  piloté par l agent \033[1;31mnon\033[0m — le sandbox ne résout pas « desktop »\n'
  fi
else
  printf '  conteneur desktop absent — lance : bash deploy/desktop-up.sh\n'
fi

t "Pont vers le Chrome de ton poste (facultatif)"
CDP=$(val BROWSER_CDP_URL)
if [ -z "$CDP" ]; then
  printf '  BROWSER_CDP_URL vide — le bot utilise son propre Chromium (normal si le pont n est pas voulu)\n'
elif [ "$CDP" = "http://desktop:9223" ]; then
  # Le pont SSH n'est plus en jeu : l'agent pilote le navigateur du serveur.
  # Diagnostiquer une passerelle Docker ici enverrait chercher une panne qui
  # n'existe pas.
  printf '  pont inutilisé — l agent pilote le navigateur du serveur (section ci-dessus)\n'
else
  printf '  BROWSER_CDP_URL          %s\n' "$CDP"
  HOSTP=${CDP#http://}; GWIP=${HOSTP%%:*}; GWPORT=${HOSTP##*:}

  # L'adresse configurée doit être celle par laquelle le sandbox sort. docker0
  # (172.17.0.1) n'est PAS la passerelle d'un conteneur placé sur un réseau
  # compose : le tunnel monte, sshd le confirme, et le conteneur part quand
  # même en timeout parce que cette adresse ne mène nulle part depuis chez lui.
  ROUTE=$("${COMPOSE[@]}" exec -T sandbox sh -c "ip route 2>/dev/null | awk '/^default/ {print \$3}'" 2>/dev/null | tr -d '\r' | head -1)
  if [ -n "$ROUTE" ]; then
    [ "$ROUTE" = "$GWIP" ] \
      && printf '  passerelle du sandbox    \033[1;32m%s (concorde)\033[0m\n' "$ROUTE" \
      || printf '  passerelle du sandbox    \033[1;31m%s — DIFFÉRENTE de %s, le conteneur ne joindra jamais ce port\033[0m\n                           correction : ssh root@<serveur> puis bash deploy/chrome-bridge-server.sh\n' "$ROUTE" "$GWIP"
  fi

  # 1. sshd accepte-t-il de publier un port sur autre chose que la boucle locale ?
  #    Sans « GatewayPorts clientspecified », sshd accepte le -R, le dit à
  #    personne, et écoute sur 127.0.0.1 seul : le conteneur ne voit rien.
  #    C'est LA panne silencieuse de ce montage.
  if grep -rqE '^[[:space:]]*GatewayPorts[[:space:]]+clientspecified' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null; then
    printf '  sshd GatewayPorts        \033[1;32mclientspecified (OK)\033[0m\n'
  else
    printf '  sshd GatewayPorts        \033[1;31mABSENT — le tunnel inverse ne sortira jamais de 127.0.0.1\033[0m\n'
    printf '                           correction : ssh root@<serveur> puis bash deploy/chrome-bridge-server.sh\n'
  fi

  # 2. Quelqu'un écoute-t-il réellement sur l'adresse attendue ?
  ECOUTE=$( (ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | grep -E "[:.]$GWPORT[[:space:]]" )
  if [ -n "$ECOUTE" ]; then
    printf '  écoute sur le port %s    \033[1;32moui\033[0m\n' "$GWPORT"
    printf '%s\n' "$ECOUTE" | sed 's/^/    | /'
    printf '%s' "$ECOUTE" | grep -q "$GWIP:$GWPORT" \
      && printf '  liée à %s        \033[1;32moui — le conteneur peut la joindre\033[0m\n' "$GWIP" \
      || printf '  liée à %s        \033[1;31mNON (127.0.0.1 seulement) — le conteneur ne la joindra pas\033[0m\n' "$GWIP"
  else
    printf '  écoute sur le port %s    \033[1;31mpersonne\033[0m\n' "$GWPORT"
    printf '                           ta fenêtre PowerShell chrome-bridge.ps1 est fermée, ou son ssh a été refusé\n'
  fi

  # 3. Le conteneur, lui, arrive-t-il à parler à Chrome ? C'est la seule
  #    question qui compte vraiment : les deux contrôles ci-dessus ne sont
  #    que les causes possibles de sa réponse.
  VER=$("${COMPOSE[@]}" exec -T sandbox curl -fsS --max-time 5 "http://$GWIP:$GWPORT/json/version" 2>/dev/null | tr -d '\n' | head -c 200)
  [ -n "$VER" ] && printf '  \033[1;32mle conteneur JOINT ton Chrome\033[0m : %s\n' "$VER" \
                || printf '  \033[1;31mle conteneur ne joint pas ton Chrome\033[0m (c est ce que le bot signale)\n'
fi

t "Coffre"
N=$("${COMPOSE[@]}" exec -T db psql -qtA -U manzi -d manzi -c 'select count(*) from credentials' 2>/dev/null | tr -d ' \r')
printf '  identifiants enregistrés : %s\n' "${N:-lecture impossible}"

echo
