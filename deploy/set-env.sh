#!/usr/bin/env bash
# Écrit des valeurs dans le .env du serveur, sans les afficher.
#
#   bash deploy/set-env.sh WHATSAPP_APP_ID=2851... WHATSAPP_APP_SECRET=4e8b...
#
# Pourquoi un script plutôt qu'un `sed` à la main :
#  - `sed -i` recrée le fichier ; lancé par root sur le .env de manzi, il en
#    change le propriétaire et l'orchestrateur ne le lit plus. Ici on réécrit
#    le contenu dans le fichier existant, ce qui préserve inode, droits et
#    propriétaire.
#  - une clé absente du .env doit être ajoutée, pas ignorée en silence.
#  - la valeur ne doit apparaître ni à l'écran ni dans l'historique du shell
#    du serveur : on n'imprime que le nom et la longueur.
set -euo pipefail

DIR="${MANZI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$DIR"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }

[ $# -gt 0 ] || die "usage: bash deploy/set-env.sh CLE=valeur [CLE=valeur ...]"
[ -f .env ] || die "pas de .env dans $DIR"

# Un \r de fin de ligne Windows se retrouve collé à chaque valeur et fausse
# toute comparaison octet à octet, sans jamais apparaître dans un message.
if grep -q $'\r' .env; then sed 's/\r$//' .env > .env.tmp && cat .env.tmp > .env && rm -f .env.tmp; fi

for pair in "$@"; do
  case "$pair" in
    *=*) ;;
    *) die "argument mal formé : « $pair » (attendu CLE=valeur)" ;;
  esac
  key=${pair%%=*}
  value=${pair#*=}
  case "$key" in
    [A-Za-z_][A-Za-z0-9_]*) ;;
    *) die "nom de clé invalide : « $key »" ;;
  esac
  [ -n "$value" ] || die "$key : valeur vide — rien n'a été écrit"

  # awk plutôt que sed : la valeur peut contenir n'importe quel caractère
  # (y compris & ou |), qui aurait un sens pour sed et serait réécrit.
  if grep -q "^$key=" .env; then
    awk -v k="$key" -v v="$value" \
      'index($0, k "=") == 1 && !done { print k "=" v; done = 1; next } { print }' \
      .env > .env.tmp
  else
    { cat .env; printf '%s=%s\n' "$key" "$value"; } > .env.tmp
  fi
  cat .env.tmp > .env
  rm -f .env.tmp
  say "$key écrit (${#value} caractères)"
done

chmod 600 .env
say "Terminé. Les conteneurs relisent le .env au prochain démarrage :"
printf '  docker compose -f docker-compose.yml -f docker-compose.eco.yml up -d --force-recreate orchestrator\n'
