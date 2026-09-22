#!/usr/bin/env bash
# Vérifie la chaîne complète d'une capture d'écran, du navigateur à WhatsApp.
#
#   ssh manzi@50.21.190.19 'cd manzi-junior && bash deploy/test-capture.sh'
#
# « Le screenshot ne marche pas » est un symptôme, pas un diagnostic : la
# chaîne a quatre maillons — le navigateur répond, le fichier existe dans le
# sandbox, Meta accepte le téléversement, Meta accepte l'envoi — et chacun
# casse pour une raison différente. Cette commande les parcourt dans l'ordre
# et s'arrête au premier qui lâche, en disant lequel.
#
# Un numéro en argument pour l'envoyer ailleurs que sur le premier de
# WHATSAPP_ALLOWED_NUMBERS.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)
"${COMPOSE[@]}" exec -T orchestrator node dist/cli.js test-capture ${1:+"$1"}
