#!/usr/bin/env bash
# Prépare le serveur à recevoir le tunnel inverse de TON Chrome. Une fois, en root :
#
#   sudo bash deploy/chrome-bridge-server.sh
#
# Le sandbox joint ton Chrome par `host.docker.internal`, c'est-à-dire la
# passerelle Docker de l'hôte. Un `ssh -R` n'écoute par défaut que sur la
# boucle locale du serveur, où aucun conteneur ne peut aller : il faut
# autoriser le client à choisir son adresse d'écoute, et lui faire choisir
# cette passerelle — jamais 0.0.0.0, qui publierait le pilotage de ton
# navigateur sur Internet.
#
# Chrome refuse par ailleurs toute requête de débogage dont l'en-tête Host
# n'est ni « localhost » ni une adresse IP. BROWSER_CDP_URL doit donc porter
# l'IP de la passerelle, pas le nom `host.docker.internal`.
set -euo pipefail

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "à lancer en root : sudo bash deploy/chrome-bridge-server.sh"

DIR="${MANZI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$DIR"
[ -f .env ] || die "pas de .env dans $DIR"
OWNER=$(stat -c %U "$DIR")

# 1. L'adresse que le sandbox appelle ------------------------------------------
# On la demande au conteneur lui-même plutôt que de la deviner : c'est Docker
# qui décide à quoi `host.docker.internal` se résout.
GW=$(docker exec manzi-sandbox getent hosts host.docker.internal 2>/dev/null | awk '{print $1}' | head -1 || true)
if [ -z "$GW" ]; then
  GW=$(ip -4 addr show docker0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1 || true)
fi
[ -n "$GW" ] || die "impossible de déterminer l'adresse de la passerelle Docker (le sandbox tourne-t-il ?)"
say "le sandbox joindra ton Chrome sur $GW:9222"

# 2. Autoriser un ssh -R à écouter sur cette adresse ----------------------------
# `clientspecified` et non `yes` : `yes` ferait écouter sur toutes les
# interfaces, y compris publique.
if grep -qE '^[[:space:]]*GatewayPorts[[:space:]]+clientspecified' /etc/ssh/sshd_config; then
  say "sshd : GatewayPorts déjà en clientspecified"
else
  cp /etc/ssh/sshd_config "/etc/ssh/sshd_config.bak.$(date +%Y%m%d%H%M%S)"
  if grep -qE '^[[:space:]]*#?[[:space:]]*GatewayPorts' /etc/ssh/sshd_config; then
    sed -i 's|^[[:space:]]*#\?[[:space:]]*GatewayPorts.*|GatewayPorts clientspecified|' /etc/ssh/sshd_config
  else
    printf '\nGatewayPorts clientspecified\n' >> /etc/ssh/sshd_config
  fi
  sshd -t || die "sshd_config invalide après modification — restaure la sauvegarde /etc/ssh/sshd_config.bak.*"
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  say "sshd : GatewayPorts passé à clientspecified (sauvegarde faite)"
fi

# 3. La clé SSH du poste doit ouvrir le compte de service ------------------------
# Le tunnel se connecte en tant que $OWNER, pas root. Sans la clé, ssh demande
# un mot de passe : le pont ne peut alors ni se rétablir seul après une coupure,
# ni tourner sans quelqu'un devant l'écran. On recopie les clés déjà autorisées
# pour root — ce sont celles du poste de l'opérateur, il n'y en a pas d'autres.
ROOT_KEYS=/root/.ssh/authorized_keys
USER_KEYS="/home/$OWNER/.ssh/authorized_keys"
if [ -s "$ROOT_KEYS" ]; then
  install -d -o "$OWNER" -g "$OWNER" -m 700 "/home/$OWNER/.ssh"
  touch "$USER_KEYS"
  added=0
  while IFS= read -r k; do
    case "$k" in ssh-*|ecdsa-*|sk-ssh-*|sk-ecdsa-*) ;; *) continue ;; esac
    grep -qxF "$k" "$USER_KEYS" || { printf '%s\n' "$k" >> "$USER_KEYS"; added=$((added + 1)); }
  done < "$ROOT_KEYS"
  chown "$OWNER:$OWNER" "$USER_KEYS"; chmod 600 "$USER_KEYS"
  [ "$added" -gt 0 ] && say "$added clé(s) SSH recopiée(s) vers $OWNER (connexion sans mot de passe)" || say "clés SSH de $OWNER déjà en place"
else
  say "aucune clé dans $ROOT_KEYS — le tunnel demandera un mot de passe"
fi

# 4. Refuser que 9222 sorte sur Internet ----------------------------------------
# Le client demandera explicitement $GW, mais une erreur de frappe côté PC
# suffirait à publier le port. On ferme la porte ici, une fois.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw deny 9222/tcp >/dev/null 2>&1 || true
  say "pare-feu : 9222 refusé depuis l'extérieur"
else
  say "pare-feu ufw inactif — 9222 n'écoutera que sur $GW, mais pense à activer ufw"
fi

# 5. Configurer l'orchestrateur --------------------------------------------------
sudo -u "$OWNER" -H bash "$DIR/deploy/set-env.sh" BROWSER_CDP_URL="http://$GW:9222"

# Accès complet, comme demandé : aucun domaine exclu par défaut. Le mécanisme
# existe si l'avis change un jour — il suffit de remplir la variable :
#   bash deploy/set-env.sh BROWSER_DENY_DOMAINS=banque.se,paypal.com
DENY=$(grep -E '^BROWSER_DENY_DOMAINS=' .env | head -1 | cut -d= -f2- | tr -d '"\r')
if [ -n "$DENY" ]; then
  say "domaines exclus du navigateur : $DENY"
else
  say "aucun domaine exclu — l'agent atteint tout ce que ce Chrome atteint"
fi

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.eco.yml)
sudo -u "$OWNER" -H "${COMPOSE[@]}" up -d --force-recreate orchestrator >/dev/null
say "orchestrateur redémarré avec BROWSER_CDP_URL"

cat <<EOF

────────────────────────────────────────────────────────────────
CÔTÉ SERVEUR : PRÊT

Il reste à ouvrir le pont depuis ton PC Windows. Récupère le script :

  scp $OWNER@\$(hostname -I | awk '{print \$1}'):$DIR/deploy/chrome-bridge.ps1 \$HOME\\chrome-bridge.ps1

puis, dans PowerShell :

  \$env:MANZI_HOST='$OWNER@<ip-du-serveur>'; \$env:MANZI_GW='$GW'; .\\chrome-bridge.ps1

Tant que cette fenêtre PowerShell reste ouverte, Manzi Junior voit ton Chrome.
Quand tu la fermes, il retombe sur son propre Chromium, sans tes sessions.
────────────────────────────────────────────────────────────────
EOF
