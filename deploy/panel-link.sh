#!/usr/bin/env bash
# Ouvre le panneau : lien à usage unique, valable 10 minutes.
#
#   ssh manzi@50.21.190.19 'cd manzi-junior && bash deploy/panel-link.sh'
#
# Le panneau est l'endroit où l'on ajoute, met en pause, priorise et teste un
# service — modèles, GitHub, Vercel, recherche. Une clé collée ici est en
# service en quinze secondes, sans redémarrage et sans toucher au .env ;
# le bouton « Tester la clé » appelle vraiment le service et dit ce qui cloche.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)
PUBLIC=$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')
if [ -n "$PUBLIC" ]; then
  "${COMPOSE[@]}" exec -T -e "PUBLIC_URL=$PUBLIC" orchestrator node dist/cli.js vault-link panel
else
  "${COMPOSE[@]}" exec -T orchestrator node dist/cli.js vault-link panel
fi
