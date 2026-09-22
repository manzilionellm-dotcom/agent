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

# Le `tr -d '\r'` n'est pas de la superstition : une valeur écrite depuis
# Windows traîne un retour chariot, et une comparaison qui échoue sur un
# caractère invisible coûte une heure.
val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }

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
    echo "    en ligne après ${i} s"
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
[ -n "$TOKEN" ] || die "ORCHESTRATOR_TOKEN est vide dans .env — la page du coffre serait ouverte à tous"

# L'adresse publique. Refuser de continuer parce que le .env ne la contient
# pas serait absurde : le tunnel tourne, il la connaît, et tout le reste du
# travail est déjà fait. On la lit dans sa configuration reçue, exactement
# comme whatsapp-up.sh, et on répare le .env au passage.
PUBLIC=$(val PUBLIC_URL)
if [ -z "$PUBLIC" ]; then
  say "PUBLIC_URL absente du .env — lecture dans les journaux du tunnel"
  # Le service tunnel vit derriere un profil compose : sans --profile,
  # `logs tunnel` ne renvoie rien et on conclut a tort que le tunnel est muet.
  HOST=$(docker compose -f docker-compose.yml -f docker-compose.eco.yml \
    --profile tunnel --profile tunnel-quick logs --no-color tunnel tunnel-quick 2>/dev/null \
    | tr -d '\\' | grep -oE '"hostname":"[^"]+"' | cut -d'"' -f4 | grep -v '^$' | tail -1 || true)
  if [ -n "$HOST" ]; then
    PUBLIC="https://$HOST"
    bash deploy/set-env.sh "PUBLIC_URL=$PUBLIC" >/dev/null && echo "    trouvée et réécrite dans .env : $PUBLIC"
  else
    echo "    journaux du tunnel muets"
  fi
fi

# Un billet inventé doit être refusé : c'est le contrôle qui prouve que la
# page n'est pas ouverte à tous. Le vérifier maintenant vaut mieux que de
# le découvrir le jour où quelqu'un d'autre l'ouvre.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8787/vault?t=billet-invente" || echo 000)
[ "$CODE" = 401 ] && echo "    page du coffre protégée (un faux billet reçoit 401)" \
                  || echo "    attention : un faux billet reçoit HTTP $CODE au lieu de 401"

say "génération d'un lien d'accès à usage unique"
if ! LIEN=$("${COMPOSE[@]}" exec -T orchestrator node dist/cli.js vault-link 2>&1); then
  printf '%s\n' "$LIEN"
  die "impossible de générer le lien — relance: bash deploy/vault-link.sh"
fi

cat <<FIN

──────────────────────────────────────────────────────────────
  COFFRE PRÊT
$LIEN
  Ce lien meurt à la première ouverture. Il ne contient aucun
  secret réutilisable : le recopier ne sert à rien, et ne
  risque rien. Pour en avoir un autre :

  ssh manzi@50.21.190.19 'cd manzi-junior && bash deploy/vault-link.sh'
──────────────────────────────────────────────────────────────

FIN
