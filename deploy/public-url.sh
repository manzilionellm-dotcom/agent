#!/usr/bin/env bash
# Retrouve l'adresse publique du serveur et la réécrit dans .env.
#
#   bash deploy/public-url.sh          → affiche l'adresse retenue
#   bash deploy/public-url.sh --quiet  → n'affiche que l'adresse
#
# PUBLIC_URL sert à trois choses : le webhook WhatsApp, les liens vers le
# coffre, et le lien que l'agent envoie quand il a besoin d'aide pour une
# connexion. Sans elle, l'agent répond « PUBLIC_URL absente » et ne peut rien
# demander depuis le téléphone de l'opérateur.
#
# Trois sources, de la plus sûre à la moins sûre :
#
#   1. Le .env, s'il la porte déjà.
#   2. Le callback enregistré chez Meta. C'est la source la PLUS fiable
#      quand WhatsApp fonctionne : si les messages arrivent, cette adresse
#      est nécessairement la bonne, aujourd'hui, en production. Aucun
#      raisonnement ne bat une observation.
#   3. Les journaux du tunnel, qui portent la configuration qu'il a reçue.
#      Vrai aussi, mais les journaux tournent et peuvent être vides.

set -uo pipefail
cd "$(dirname "$0")/.."

QUIET=0
for a in "$@"; do [ "$a" = "--quiet" ] && QUIET=1; done
say() { [ "$QUIET" = 1 ] || printf '==> %s\n' "$*"; }

val() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"\r'; }

COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)

PUBLIC=$(val PUBLIC_URL)
if [ -n "$PUBLIC" ]; then
  say "PUBLIC_URL déjà en place"
  printf '%s\n' "$PUBLIC"
  exit 0
fi

# --- 2. Ce que Meta a enregistré ---------------------------------------------
APP=$(val WHATSAPP_APP_ID); SEC=$(val WHATSAPP_APP_SECRET)
if [ -n "$APP" ] && [ -n "$SEC" ]; then
  say "lecture du callback enregistré chez Meta"
  CB=$(curl -fsS --max-time 10 "https://graph.facebook.com/v21.0/$APP/subscriptions?access_token=$APP%7C$SEC" 2>/dev/null \
       | grep -oE '"callback_url":"[^"]+"' | head -1 | cut -d'"' -f4 | sed 's|\\/|/|g')
  # On ne garde que le schéma et l'hôte : le callback porte le chemin
  # /whatsapp/webhook, et le recopier donnerait des liens de coffre en
  # https://…/whatsapp/webhook/vault, c'est-à-dire des 404.
  case "$CB" in
    https://*) PUBLIC=$(printf '%s' "$CB" | cut -d/ -f1-3) ;;
  esac
fi

# --- 3. Les journaux du tunnel ------------------------------------------------
if [ -z "$PUBLIC" ]; then
  say "lecture du nom d'hôte dans les journaux du tunnel"
  HOST=$("${COMPOSE[@]}" --profile tunnel --profile tunnel-quick logs --no-color tunnel tunnel-quick 2>/dev/null \
    | tr -d '\\' | grep -oE '"hostname":"[^"]+"' | cut -d'"' -f4 | grep -v '^$' | tail -1)
  [ -n "$HOST" ] && PUBLIC="https://$HOST"
fi
if [ -z "$PUBLIC" ]; then
  QUICK=$("${COMPOSE[@]}" --profile tunnel-quick logs --no-color tunnel-quick 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
  [ -n "$QUICK" ] && PUBLIC="$QUICK"
fi

if [ -z "$PUBLIC" ]; then
  printf 'adresse publique introuvable — lance: bash deploy/whatsapp-up.sh\n' >&2
  exit 1
fi

# Elle répond vraiment ? Écrire une adresse morte dans le .env transforme un
# problème visible en liens qui échouent en silence.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC/healthz" 2>/dev/null || echo 000)
if [ "$CODE" = 200 ]; then
  say "adresse vérifiée : $PUBLIC répond sur /healthz"
else
  say "attention : $PUBLIC répond HTTP $CODE sur /healthz (on l'écrit quand même, le tunnel peut mettre un instant)"
fi

# Une adresse *.trycloudflare.com est un tunnel « quick » : elle est tirée au
# hasard à chaque démarrage. Tout continue de marcher — le minuteur redéclare
# le webhook toutes les 10 minutes — mais chaque lien déjà envoyé meurt, et le
# bot ne peut plus demander d'aide sur un lien qu'il vient d'émettre. Le dire
# vaut mieux que le laisser découvrir un soir.
case "$PUBLIC" in
  *.trycloudflare.com)
    say "ATTENTION : adresse ÉPHÉMÈRE (tunnel « quick »). Elle changera au prochain redémarrage."
    if [ -n "$(val CLOUDFLARE_TUNNEL_TOKEN)" ]; then
      say "un CLOUDFLARE_TUNNEL_TOKEN existe pourtant — le tunnel nommé ne tourne pas : bash deploy/whatsapp-up.sh"
    else
      say "pour une adresse fixe : crée un tunnel nommé dans Cloudflare Zero Trust et pose CLOUDFLARE_TUNNEL_TOKEN"
    fi ;;
esac

bash deploy/set-env.sh "PUBLIC_URL=$PUBLIC" >/dev/null || { printf 'écriture du .env impossible\n' >&2; exit 1; }
say "PUBLIC_URL rétablie"
printf '%s\n' "$PUBLIC"
