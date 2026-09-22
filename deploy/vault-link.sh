#!/usr/bin/env bash
# Ouvre le coffre : génère un lien à usage unique, valable 10 minutes.
#
#   ssh manzi@50.21.190.19 'cd manzi-junior && bash deploy/vault-link.sh'
#
# Le lien meurt à la première ouverture. C'est la différence qui compte avec
# l'ancienne méthode : un jeton d'API dans une URL reste valable pour
# toujours et finit recopié — dans un historique, une capture d'écran, un
# message envoyé pour montrer que ça marche. Un billet recopié ne vaut rien.

set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)

# PUBLIC_URL est relue ICI, dans le .env, et réinjectée dans la commande.
#
# Un conteneur charge son env_file au moment où il est créé, pas à chaque
# appel : quand whatsapp-up.sh vient d'écrire PUBLIC_URL, le processus qui
# tourne ne la connaît toujours pas. Le lien sortait alors en 127.0.0.1
# alors que l'adresse publique existait depuis trente secondes.
PUBLIC=$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')

if [ -n "$PUBLIC" ]; then
  "${COMPOSE[@]}" exec -T -e "PUBLIC_URL=$PUBLIC" orchestrator node dist/cli.js vault-link "${1:-vault}"
else
  "${COMPOSE[@]}" exec -T orchestrator node dist/cli.js vault-link "${1:-vault}"
fi
