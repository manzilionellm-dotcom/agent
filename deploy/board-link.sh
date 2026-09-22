#!/usr/bin/env bash
# Ouvre le tableau de bord : lien à usage unique, valable 10 minutes.
#
#   ssh manzi@50.21.190.19 'cd manzi-junior && bash deploy/board-link.sh'
#
# Le tableau de bord montre en une page ce que l'API rendait déjà : agents,
# tâches, journal, dépense du jour, état du navigateur et du coffre. Il se
# rafraîchit tout seul et s'ouvre sur un téléphone.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)
PUBLIC=$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')
if [ -n "$PUBLIC" ]; then
  "${COMPOSE[@]}" exec -T -e "PUBLIC_URL=$PUBLIC" orchestrator node dist/cli.js vault-link board
else
  "${COMPOSE[@]}" exec -T orchestrator node dist/cli.js vault-link board
fi
