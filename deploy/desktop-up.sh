#!/usr/bin/env bash
# Met en service le navigateur du serveur, et le branche à l'agent.
#
#   bash deploy/desktop-up.sh
#
# Ce que ça change, concrètement : l'agent cesse de dépendre d'un navigateur
# qui vit sur le portable de l'opérateur. Le Chromium tourne ici, son profil
# est un volume Docker, et les comptes connectés une fois le restent —
# portable éteint, Wi-Fi coupé, opérateur en ville.
#
# Relançable sans risque. Le profil n'est jamais effacé : c'est lui qui porte
# les sessions, et le refabriquer obligerait à tout reconnecter à la main.

set -uo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERREUR: %s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "aucun .env ici ($(pwd))"

COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)

say "construction du navigateur du serveur (long la première fois)"
"${COMPOSE[@]}" up -d --build desktop || die "construction impossible — voir: ${COMPOSE[*]} logs desktop"

say "attente du navigateur"
PRET=0
for i in $(seq 1 90); do
  if "${COMPOSE[@]}" exec -T desktop curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    PRET=1
    echo "    prêt après ${i} s"
    break
  fi
  sleep 1
done
if [ "$PRET" = 0 ]; then
  "${COMPOSE[@]}" logs --no-color --tail 40 desktop
  die "le navigateur n'écoute pas — journal ci-dessus"
fi

# L'orchestrateur doit piloter CE navigateur, et non plus celui du poste.
# On écrit l'adresse interne : elle ne dépend d'aucune passerelle Docker, d'où
# toute la série de pannes du pont SSH (docker0 qui n'est pas la passerelle du
# conteneur, port retenu par un tunnel mort, GatewayPorts…). Un nom de service
# sur un réseau compose, lui, résout toujours.
ANCIEN=$(grep -E '^BROWSER_CDP_URL=' .env | head -1 | cut -d= -f2- | tr -d '\r')
if [ "$ANCIEN" != "http://desktop:9223" ]; then
  [ -n "$ANCIEN" ] && say "l'agent visait « $ANCIEN » — on bascule sur le navigateur du serveur"
  bash deploy/set-env.sh BROWSER_CDP_URL=http://desktop:9223 >/dev/null || die "écriture du .env impossible"
fi

# --build, et pas seulement --force-recreate : la route /screen est du code
# TypeScript compilé dans l'image. Recréer le conteneur sans reconstruire
# relance l'ancien binaire, qui ne connaît pas /screen et répond « Bearer
# ORCHESTRATOR_TOKEN requis » — un 401 identique avec ou sans billet, qui
# envoie chercher un bug d'authentification là où il n'y en a pas.
say "reconstruction et redémarrage de l'orchestrateur"
"${COMPOSE[@]}" up -d --build --force-recreate orchestrator >/dev/null || die "reconstruction impossible : ${COMPOSE[*]} logs orchestrator"

for i in $(seq 1 40); do
  curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 40 ] && die "l'orchestrateur ne répond plus : ${COMPOSE[*]} logs --tail 40 orchestrator"
done

# Contrôle de bout en bout : c'est la seule preuve qui compte. Le reste ne dit
# que « ça devrait marcher ».
#
# On interroge l'ADRESSE IP, jamais le nom. Chrome refuse toute requête de
# débogage dont l'en-tête Host n'est ni « localhost » ni une IP : un
# `curl http://desktop:9223/...` échoue donc même quand tout fonctionne, et
# annonce une panne de réseau qui n'existe pas. Le démon du navigateur résout
# déjà le nom avant de se connecter ; ce contrôle doit faire pareil, sinon il
# teste autre chose que ce que fait l'agent.
IP=$("${COMPOSE[@]}" exec -T sandbox getent hosts desktop 2>/dev/null | awk '{print $1}' | head -1 | tr -d '\r')
if [ -z "$IP" ]; then
  echo "    ATTENTION : le sandbox ne résout pas le nom « desktop » — les deux conteneurs ne partagent pas de réseau"
else
  VER=$("${COMPOSE[@]}" exec -T sandbox curl -fsS --max-time 5 "http://$IP:9223/json/version" 2>/dev/null | head -c 160)
  [ -n "$VER" ] && echo "    l'agent joint le navigateur ($IP) : $VER" \
                || echo "    ATTENTION : « desktop » résout en $IP mais ne répond pas sur 9223"
fi

# La route existe-t-elle vraiment dans le binaire qui tourne ? Un faux billet
# doit recevoir « lien expiré », PAS « Bearer requis ». La seconde réponse
# signifie que l'image est plus ancienne que le code.
REP=$(curl -s --max-time 5 "http://127.0.0.1:8787/screen?t=billet-invente" | head -c 200)
case "$REP" in
  *"Bearer ORCHESTRATOR_TOKEN"*)
    die "l'orchestrateur en service ne connaît pas /screen — son image est périmée. Relance : ${COMPOSE[*]} up -d --build --force-recreate orchestrator" ;;
  *) echo "    route /screen en place" ;;
esac

say "génération d'un lien pour ouvrir l'écran"
LIEN=$("${COMPOSE[@]}" exec -T orchestrator node dist/cli.js vault-link 2>&1 | sed 's|/vault?t=|/screen?t=|')

cat <<FIN

──────────────────────────────────────────────────────────────
  LE NAVIGATEUR DU SERVEUR EST EN SERVICE
$LIEN
  Ouvre ce lien : tu verras l'écran du navigateur dans lequel
  l'agent travaille. Connecte-toi à tes comptes de tes propres
  mains — Google, LinkedIn, Vinted, Blocket — puis ferme
  l'onglet. Les sessions restent sur le serveur.

  Ensuite, sur WhatsApp : « navigateur, statut » doit répondre
  mode: cdp.

  Quand l'agent butera sur une connexion, il t'enverra
  lui-même un lien comme celui-ci.
──────────────────────────────────────────────────────────────

FIN
