#!/usr/bin/env bash
# Les pannes des dernières 24 h, groupées par message d'erreur exact.
#
#   ssh manzi@50.21.190.19 'cd manzi-junior && git pull -q && bash deploy/pannes.sh'
#
# Le diagnostic du bot dit « l'outil browser a échoué 98 fois » ; pour
# corriger, il faut savoir POURQUOI — et 98 échecs sont rarement 98 causes :
# ce sont deux ou trois messages qui reviennent. Ce script les compte.
#
# Rien de secret ne sort d'ici : la boîte noire caviarde tout avant d'écrire
# en base (clés, jetons, mots de passe, numéros de téléphone, liens à billet).
set -uo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && COMPOSE+=(-f docker-compose.eco.yml)
H="${1:-24}"
q() { "${COMPOSE[@]}" exec -T db psql -qtA -F ' | ' -U manzi -d manzi -c "$1" 2>&1; }
t() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }

t "Outils en échec (${H} h) : outil | action | nombre | message"
q "SELECT titre,
          coalesce(substring(detail from '\"action\":\s*\"([a-z_]+)\"'), '-'),
          count(*),
          rtrim(split_part(left(regexp_replace(coalesce(substring(detail from '\"(?:sortie|erreur)\":\s*\"(.{0,170})'), left(detail, 170)), '\s+', ' ', 'g'), 170), '\n', 1), '\"}')
     FROM boite_noire
    WHERE type='outil' AND NOT ok AND ts > now() - interval '${H} hours'
    GROUP BY 1, 2, 4 ORDER BY 3 DESC LIMIT 25"

t "Plantages (${H} h) : heure | première ligne"
q "SELECT to_char(ts AT TIME ZONE 'Europe/Stockholm', 'DD/MM HH24:MI'), left(split_part(split_part(detail, E'\n', 1), '\n', 1), 200)
     FROM boite_noire WHERE type='erreur' AND ts > now() - interval '${H} hours' ORDER BY ts DESC LIMIT 10"

t "Travaux coupés net (${H} h) : heure | type | titre"
q "SELECT to_char(debut AT TIME ZONE 'Europe/Stockholm', 'DD/MM HH24:MI'), type, left(titre, 80)
     FROM traces WHERE interrompue AND debut > now() - interval '${H} hours' ORDER BY debut DESC LIMIT 10"

t "Démarrages du bot (${H} h)"
q "SELECT to_char(ts AT TIME ZONE 'Europe/Stockholm', 'DD/MM HH24:MI'), left(detail, 80)
     FROM boite_noire WHERE type='systeme' AND titre='Démarrage' AND ts > now() - interval '${H} hours' ORDER BY ts"

t "Conversations les plus lentes : heure | secondes | actions | message reçu"
q "SELECT to_char(debut AT TIME ZONE 'Europe/Stockholm', 'DD/MM HH24:MI'), round(extract(epoch FROM fin - debut)), etapes, left(titre, 70)
     FROM traces WHERE type='conversation' AND fin IS NOT NULL AND debut > now() - interval '${H} hours'
    ORDER BY fin - debut DESC LIMIT 6"

t "Réponses vides : heure | message de Lionel juste avant"
q "SELECT to_char(a.ts AT TIME ZONE 'Europe/Stockholm', 'DD/MM HH24:MI'),
          left((SELECT u.content FROM chat_messages u WHERE u.peer=a.peer AND u.role='user' AND u.ts < a.ts ORDER BY u.ts DESC LIMIT 1), 90)
     FROM chat_messages a
    WHERE a.role='assistant' AND (trim(a.content)='Fait.' OR a.content LIKE '⚠️ Arrêté sans conclusion%') AND a.ts > now() - interval '${H} hours'
    ORDER BY a.ts DESC LIMIT 10"

t "Erreurs du journal (${H} h) : nombre | message"
q "SELECT count(*), left(titre, 120) FROM boite_noire
    WHERE type='log' AND niveau='error' AND ts > now() - interval '${H} hours'
    GROUP BY 2 ORDER BY 1 DESC LIMIT 10"

t "Clé GitHub (test réel)"
"${COMPOSE[@]}" exec -T orchestrator node -e '
  import("/app/dist/providers.js").then(async (p) => { const r = await p.testProvider("github"); console.log("  " + (r.ok ? "OK — " : "EN PANNE — ") + r.message); process.exit(0); })
  .catch((e) => { console.log("  test impossible : " + e.message); process.exit(0); })' 2>&1 | tail -2
echo
