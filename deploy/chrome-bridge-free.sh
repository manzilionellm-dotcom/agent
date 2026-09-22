#!/usr/bin/env bash
# Libère le port du pont Chrome, occupé par un tunnel SSH mort.
#
#   bash deploy/chrome-bridge-free.sh [port]     (défaut : 9222)
#
# Pourquoi ce script existe : quand la fenêtre PowerShell du pont se ferme mal
# — portable qui s'endort, Wi-Fi coupé, Ctrl+C au mauvais moment — sshd garde
# le port réservé tant qu'il n'a pas constaté la mort de la connexion, ce qui
# peut prendre des minutes. La tentative suivante reçoit alors
# « remote port forwarding failed for listen port 9222 » et le pont ne remonte
# jamais tout seul. Ici on va chercher le processus qui tient le port et on
# l'arrête.
#
# Prudence : on ne tue QUE des processus sshd, et JAMAIS celui qui exécute ce
# script. Tuer sa propre session reviendrait à se couper la branche — et
# laisserait le port pris.

set -uo pipefail
PORT="${1:-9222}"

case "$PORT" in (*[!0-9]*|"") echo "port invalide : $PORT" >&2; exit 2 ;; esac

# La session ssh qui exécute ce script, et toute sa lignée : intouchables.
MOI=$$
PROTEGES=" $MOI "
p=$PPID
while [ -n "$p" ] && [ "$p" != 1 ] && [ "$p" != 0 ]; do
  PROTEGES="$PROTEGES $p "
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
done

# Sans outil pour inspecter les ports, ce script ne sait RIEN. Le dire est la
# seule réponse honnête : répondre « port libre » parce qu'on n'a pas pu
# regarder ferait croire le problème résolu et enverrait chercher la panne
# ailleurs pendant une heure.
if command -v ss >/dev/null 2>&1; then
  ECOUTE() { ss -lntp 2>/dev/null | grep -E "[:.]$PORT[[:space:]]"; }
  LIBRE()  { ! ss -lnt 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"; }
elif command -v netstat >/dev/null 2>&1; then
  ECOUTE() { netstat -lntp 2>/dev/null | grep -E "[:.]$PORT[[:space:]]"; }
  LIBRE()  { ! netstat -lnt 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"; }
else
  echo "ni ss ni netstat sur ce serveur : impossible de savoir qui tient le port $PORT" >&2
  echo "installe-les : apt-get install -y iproute2" >&2
  exit 3
fi

PIDS=$(ECOUTE | grep -oE 'pid=[0-9]+|[0-9]+/' | grep -oE '[0-9]+' | sort -u)

if [ -z "$PIDS" ]; then
  LIBRE && { echo "port $PORT libre"; exit 0; }
  # Quelqu'un écoute, mais le propriétaire n'est pas visible : c'est le cas
  # quand le processus appartient à un autre utilisateur. Un sshd de tunnel
  # appartient à celui qui s'est connecté, donc normalement à nous.
  echo "port $PORT occupé par un processus d'un autre utilisateur — à voir en root" >&2
  exit 1
fi

TUES=0
for pid in $PIDS; do
  case "$PROTEGES" in *" $pid "*) echo "  pid $pid : c'est la session courante — ignoré"; continue ;; esac
  CMD=$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ "$CMD" != "sshd" ]; then
    echo "  pid $pid ($CMD) tient le port $PORT mais n'est pas un sshd — laissé tel quel"
    continue
  fi
  kill "$pid" 2>/dev/null && { echo "  ancien tunnel arrêté (pid $pid)"; TUES=$((TUES+1)); }
done

[ "$TUES" = 0 ] && { echo "port $PORT toujours occupé — rien à arrêter sans risque"; exit 1; }

# Vérifier plutôt que supposer : `kill` réussit avant que le port soit rendu.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.5
  LIBRE && { echo "port $PORT libéré"; exit 0; }
done
echo "port $PORT encore occupé après l'arrêt — réessaie dans une minute" >&2
exit 1
