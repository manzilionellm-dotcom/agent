#!/usr/bin/env bash
# Écrit des valeurs dans le .env du serveur, sans les afficher.
#
#   bash deploy/set-env.sh WHATSAPP_APP_ID=2851...        # valeurs non sensibles
#   printf 'CLE=secret\n' | bash deploy/set-env.sh --stdin # secrets
#
# POUR UN SECRET, UTILISER --stdin. Un argument de ligne de commande est
# visible dans `ps aux` par tout utilisateur du serveur pendant l'exécution,
# reste dans /proc/<pid>/cmdline, et — côté Windows — PSReadLine écrit chaque
# commande tapée dans un fichier sur le disque. « Ça ne s'affiche pas à
# l'écran » ne veut donc pas dire « personne ne peut le lire ».
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

[ -f .env ] || die "pas de .env dans $DIR"

# Les paires viennent soit des arguments, soit de stdin (une par ligne).
# `IFS= read -r` : sans le `IFS=` vide, les espaces d'une valeur seraient
# rognés ; sans `-r`, un antislash serait interprété. Les deux détruiraient
# silencieusement un secret qui en contient.
PAIRS=()
if [ "${1:-}" = "--stdin" ] || [ $# -eq 0 ]; then
  [ -t 0 ] && die "usage: printf 'CLE=valeur\\n' | bash deploy/set-env.sh --stdin"
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}                       # une ligne venue de Windows traîne un \r
    case "$line" in "" | \#*) continue ;; esac
    PAIRS+=("$line")
  done
  [ ${#PAIRS[@]} -gt 0 ] || die "rien reçu sur stdin"
else
  PAIRS=("$@")
fi

# Un \r de fin de ligne Windows se retrouve collé à chaque valeur et fausse
# toute comparaison octet à octet, sans jamais apparaître dans un message.
if grep -q $'\r' .env; then sed 's/\r$//' .env > .env.tmp && cat .env.tmp > .env && rm -f .env.tmp; fi

for pair in "${PAIRS[@]}"; do
  case "$pair" in
    *=*) ;;
    *) die "argument mal formé : « $pair » (attendu CLE=valeur)" ;;
  esac
  key=${pair%%=*}
  value=${pair#*=}
  # `[A-Za-z_][A-Za-z0-9_]*` en glob exige DEUX caractères — le second groupe
  # est une classe suivie de `*`, pas une répétition de la classe. On teste
  # donc l'inverse : aucun caractère interdit, et pas de chiffre en tête.
  case "$key" in
    "" | [0-9]* | *[!A-Za-z0-9_]*) die "nom de clé invalide : « $key »" ;;
  esac
  [ -n "$value" ] || die "$key : valeur vide — rien n'a été écrit"

  # awk plutôt que sed : la valeur peut contenir n'importe quel caractère
  # (y compris & ou |), qui aurait un sens pour sed et serait réécrit.
  if grep -q "^$key=" .env; then
    awk -v k="$key" -v v="$value" \
      'index($0, k "=") == 1 && !done { print k "=" v; done = 1; next } { print }' \
      .env > .env.tmp
  else
    # Un .env dont la dernière ligne n'a pas de saut de ligne final colle la
    # clé ajoutée à la précédente : `SANDBOX_TIMEOUT_MS=900000NOUVELLE_CLE=x`.
    # Les deux valeurs deviennent fausses, et seule la première le dit — par
    # un « Invalid input » qui ne parle jamais de la clé qu'on vient d'écrire.
    { cat .env; [ -n "$(tail -c1 .env)" ] && printf '\n'; printf '%s=%s\n' "$key" "$value"; } > .env.tmp
  fi
  cat .env.tmp > .env
  rm -f .env.tmp

  # On se relit : la valeur écrite doit être celle qu'un lecteur du .env
  # retrouvera. C'est ce contrôle, et non la prudence, qui aurait attrapé le
  # collage ci-dessus le jour où il s'est produit.
  relu=$(grep -E "^$key=" .env | head -1 | cut -d= -f2-)
  [ "$relu" = "$value" ] || die "$key relu différemment de ce qui a été écrit — .env laissé tel quel, vérifie-le à la main"
  n=$(grep -cE "^$key=" .env)
  [ "$n" = 1 ] || die "$key apparaît $n fois dans .env — corrige-le à la main"
  say "$key écrit (${#value} caractères)"
done

chmod 600 .env
say "Terminé. Les conteneurs relisent le .env au prochain démarrage :"
printf '  docker compose -f docker-compose.yml -f docker-compose.eco.yml up -d --force-recreate orchestrator\n'
