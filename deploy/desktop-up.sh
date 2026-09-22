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

# Le profil tourne sous un compte non root. Un volume créé avant ce
# changement appartient à root, et le navigateur ne peut alors rien y écrire.
# On ne le recrée QUE s'il est vide : un profil rempli porte les sessions, et
# les jeter obligerait à tout reconnecter à la main.
VOL=$(docker volume ls -q --filter name=_desktop | head -1)
if [ -n "$VOL" ]; then
  VIDE=$(docker run --rm -v "$VOL":/p alpine sh -c 'ls -A /p 2>/dev/null | head -1' 2>/dev/null)
  PROP=$(docker run --rm -v "$VOL":/p alpine stat -c %u /p 2>/dev/null)
  if [ -z "$VIDE" ] && [ "$PROP" = 0 ]; then
    say "profil vide et appartenant à root — recréation pour le compte non root"
    docker rm -f manzi-desktop >/dev/null 2>&1 || true
    docker volume rm "$VOL" >/dev/null 2>&1 || true
  elif [ -n "$VIDE" ] && [ "$PROP" = 0 ]; then
    say "ATTENTION : le profil contient des données mais appartient à root"
    echo "    le navigateur ne pourra pas y écrire. Pour repartir de zéro (sessions perdues) :"
    echo "      docker rm -f manzi-desktop && docker volume rm $VOL"
  fi
fi

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
if [ "$ANCIEN" != "http://desktop:9222" ]; then
  [ -n "$ANCIEN" ] && say "l'agent visait « $ANCIEN » — on bascule sur le navigateur du serveur"
  bash deploy/set-env.sh BROWSER_CDP_URL=http://desktop:9222 >/dev/null || die "écriture du .env impossible"
fi

say "redémarrage de l'orchestrateur"
"${COMPOSE[@]}" up -d --force-recreate orchestrator >/dev/null || die "redémarrage impossible"

for i in $(seq 1 40); do
  curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 40 ] && die "l'orchestrateur ne répond plus : ${COMPOSE[*]} logs --tail 40 orchestrator"
done

# Contrôle de bout en bout : c'est la seule preuve qui compte. Le reste ne dit
# que « ça devrait marcher ».
VER=$("${COMPOSE[@]}" exec -T sandbox curl -fsS --max-time 5 http://desktop:9222/json/version 2>/dev/null | head -c 160)
[ -n "$VER" ] && echo "    l'agent joint le navigateur : $VER" \
              || echo "    ATTENTION : l'agent ne joint pas encore le navigateur (réseau interne à vérifier)"

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
