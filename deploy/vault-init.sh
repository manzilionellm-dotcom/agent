#!/usr/bin/env bash
# Active le coffre d'identifiants : clé maîtresse, reconstruction, adresse de la page.
#
#   bash deploy/vault-init.sh
#
# Ce script existe pour une raison bête et coûteuse : PowerShell 5.1 retire
# les guillemets d'une commande avant de la passer à ssh. Une ligne unique
# avec des $( ) et des guillemets imbriqués arrive donc tronquée côté serveur,
# et bash répond « unexpected EOF ». Trois fois que ça nous coûte un aller-
# retour. La commande à taper ne contient plus un seul guillemet :
#
#   ssh manzi@50.21.190.19 'cd manzi-junior && git pull && bash deploy/vault-init.sh'
#
# Relançable sans risque : si VAULT_KEY existe déjà, il ne la remplace pas —
# la remplacer rendrait illisibles tous les mots de passe déjà enregistrés.

set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERREUR: %s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "aucun .env ici ($(pwd)). Lance ce script depuis ~/manzi-junior."

COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)

val() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }

# --- 1. Clé maîtresse -----------------------------------------------------
if [ -n "$(val VAULT_KEY)" ]; then
  say "VAULT_KEY déjà présente — on la garde"
  echo "    (la remplacer rendrait illisibles les mots de passe déjà enregistrés)"
else
  say "génération de la clé maîtresse du coffre"
  openssl rand -base64 32 | sed 's|^|VAULT_KEY=|' | bash deploy/set-env.sh --stdin
fi

# --- 2. Reconstruction ----------------------------------------------------
say "reconstruction de l'orchestrateur et du sandbox"
if ! "${COMPOSE[@]}" up -d --build orchestrator sandbox; then
  die "reconstruction impossible — relance avec: ${COMPOSE[*]} up -d --build orchestrator sandbox"
fi

# --- 3. Vérification ------------------------------------------------------
say "attente de l'orchestrateur"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    echo "    en ligne après ${i}0 s au plus"
    break
  fi
  sleep 1
  [ "$i" = 30 ] && {
    echo "    pas de réponse — 40 dernières lignes du journal :"
    "${COMPOSE[@]}" logs --no-color --tail 40 orchestrator || true
    die "l'orchestrateur ne répond pas sur /healthz"
  }
done

TOKEN=$(val ORCHESTRATOR_TOKEN)
PUBLIC=$(val PUBLIC_URL)
[ -n "$TOKEN" ] || die "ORCHESTRATOR_TOKEN est vide dans .env — la page du coffre serait ouverte à tous"
[ -n "$PUBLIC" ] || die "PUBLIC_URL est vide dans .env — lance d'abord: bash deploy/whatsapp-up.sh"

# La page répond-elle vraiment ? Un 401 ici veut dire que le jeton lu n'est
# pas celui que le serveur attend — mieux vaut le savoir maintenant que
# devant une page « Accès refusé » sans explication.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8787/vault?k=$TOKEN" || echo 000)
case "$CODE" in
  302) echo "    page du coffre vérifiée (redirection vers le formulaire)" ;;
  401) die "la page du coffre refuse ce jeton (HTTP 401) — vérifie ORCHESTRATOR_TOKEN dans .env" ;;
  *)   echo "    réponse inattendue de la page du coffre : HTTP $CODE (on continue)" ;;
esac

cat <<FIN

──────────────────────────────────────────────────────────────
  COFFRE PRÊT

  Ouvre cette adresse dans ton navigateur :

  $PUBLIC/vault?k=$TOKEN

  Le jeton disparaît de la barre d'adresse dès la première page.
  Ne recolle cette adresse dans aucune conversation.
──────────────────────────────────────────────────────────────

FIN
