#!/usr/bin/env bash
# Remplace ORCHESTRATOR_TOKEN par un jeton neuf, et redémarre l'orchestrateur.
#
#   ssh manzi@50.21.190.19 'cd manzi-junior && bash deploy/rotate-token.sh'
#
# À lancer dès qu'un jeton a été vu ailleurs que dans le .env : collé dans
# une conversation, affiché dans une capture d'écran, laissé dans un
# historique de commandes. La règle ne se discute pas et ne se nuance pas —
# un secret qui a été vu est un secret mort, quelle que soit la personne
# qui l'a vu.
#
# Le nouveau jeton ne s'affiche PAS. Rien n'en a besoin : la page du coffre
# s'ouvre par `deploy/vault-link.sh`, et l'API locale lit le .env.

set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERREUR: %s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "aucun .env ici ($(pwd))"

COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)

ANCIEN=$(grep -E '^ORCHESTRATOR_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '\r' || true)

say "génération d'un jeton neuf"
openssl rand -base64 30 | tr -d '/+=' | cut -c1-40 | sed 's|^|ORCHESTRATOR_TOKEN=|' | bash deploy/set-env.sh --stdin

NOUVEAU=$(grep -E '^ORCHESTRATOR_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '\r')
[ -n "$NOUVEAU" ] || die "le nouveau jeton est vide — .env à vérifier à la main"
[ "$NOUVEAU" != "$ANCIEN" ] || die "le jeton n'a pas changé — .env à vérifier à la main"

say "redémarrage de l'orchestrateur"
"${COMPOSE[@]}" up -d --force-recreate orchestrator >/dev/null

say "vérification"
for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 30 ] && die "l'orchestrateur ne répond plus : ${COMPOSE[*]} logs --tail 40 orchestrator"
done

# L'ancien jeton doit être refusé : c'est la seule preuve que la rotation a
# servi à quelque chose. Sans ce contrôle, on croit avoir révoqué et on a
# seulement écrit dans un fichier.
if [ -n "$ANCIEN" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ANCIEN" http://127.0.0.1:8787/tasks || echo 000)
  [ "$CODE" = 401 ] && echo "    ancien jeton refusé (HTTP 401) — révocation effective" \
                    || die "l'ancien jeton répond encore HTTP $CODE : la rotation n'a PAS pris"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NOUVEAU" http://127.0.0.1:8787/tasks || echo 000)
[ "$CODE" = 200 ] && echo "    nouveau jeton accepté (HTTP 200)" || echo "    attention : le nouveau jeton répond HTTP $CODE"

cat <<'FIN'

──────────────────────────────────────────────────────────────
  JETON REMPLACÉ

  Il ne s'affiche pas, et tu n'en as pas besoin :
    · le coffre s'ouvre avec  bash deploy/vault-link.sh
    · l'orchestrateur lit le .env tout seul

  À mettre à jour si tu les utilises :
    · Jarvis (jarvis/.env)  → ORCHESTRATOR_TOKEN
    · un éventuel script local qui appelle l'API
──────────────────────────────────────────────────────────────

FIN
