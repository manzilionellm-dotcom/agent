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

"${COMPOSE[@]}" exec -T orchestrator node dist/cli.js vault-link
