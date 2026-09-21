#!/usr/bin/env bash
# Bootstrap d'un VPS Debian 12 / Ubuntu 24.04 vierge → Manzi Junior 24/7.
# Usage (en root) : bash vps-bootstrap.sh <utilisateur> <repo-git-url> [github-token] [branche]
#
# La branche est facultative (défaut : branche par défaut du dépôt). Elle sert quand le code
# à déployer n'est pas encore fusionné dans `main` ; `install.sh` continue ensuite de suivre
# cette branche à chaque `git pull`. Peut aussi être passée via REPO_BRANCH=...
#
# Dépôt PRIVÉ : passe ton fine-grained token (Contents: Read) en 3e argument ou via
# GITHUB_TOKEN=... ; il est stocké pour l'utilisateur du bot (git credential store,
# fichier en 600) afin que le clone ET les `git pull` de install.sh fonctionnent.
# Pour récupérer ce script depuis un dépôt privé :
#   curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
#     https://raw.githubusercontent.com/<owner>/agent/main/deploy/vps-bootstrap.sh \
#     | bash -s -- manzi https://github.com/<owner>/agent.git "$GITHUB_TOKEN"
# Serveur qui héberge DÉJÀ d'autres services (site, apps) : SKIP_HARDENING=1 saute le pare-feu,
# le durcissement SSH et le swap, pour ne rien casser d'existant. Docker + utilisateur + dépôt +
# service systemd sont toujours installés.
set -euo pipefail

USER_NAME="${1:-manzi}"
REPO_URL="${2:?URL du dépôt git}"
GH_TOKEN="${3:-${GITHUB_TOKEN:-}}"
BRANCH="${4:-${REPO_BRANCH:-}}"

echo "== 1. Système"
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades git

echo "== 2. Utilisateur non-root"
id -u "$USER_NAME" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$USER_NAME"

echo "== 3. Docker (dépôt officiel)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "   déjà installé, rien à faire"
else
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  # --batch --yes : sans ces options, gpg demande « écraser le fichier ? » dès la
  # deuxième exécution et cherche un /dev/tty que `ssh host "cmd"` ne fournit pas.
  # Le script doit pouvoir être relancé : c'est ainsi qu'on applique une mise à jour.
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
usermod -aG docker "$USER_NAME"

if [ "${SKIP_HARDENING:-0}" = "1" ]; then
  echo "== 4-6. SKIP_HARDENING=1 : pare-feu, SSH et swap laissés tels quels (serveur partagé)"
  grep -q '^GatewayPorts' /etc/ssh/sshd_config || echo "   (tunnel navigateur : ajoute 'GatewayPorts clientspecified' dans /etc/ssh/sshd_config si tu veux BROWSER_CDP_URL)"
else
echo "== 4. Pare-feu : SSH seulement (le bot n'expose rien)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "== 5. Durcissement SSH + mises à jour auto"
# Ne JAMAIS couper l'authentification par mot de passe tant qu'aucune clé n'est en
# place : sinon ce script enferme l'opérateur hors de sa propre machine, et seule la
# console du fournisseur permet d'y revenir. Le durcissement s'applique à la
# ré-exécution suivante, une fois la clé installée.
if grep -qs '^\(ssh-\|ecdsa-\|sk-ssh\)' /root/.ssh/authorized_keys "/home/$USER_NAME/.ssh/authorized_keys"; then
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  echo "   clé SSH détectée : authentification par mot de passe désactivée."
else
  echo "   AUCUNE clé SSH : authentification par mot de passe CONSERVÉE."
  echo "   Installe ta clé, puis relance ce script pour durcir :"
  echo "     ssh-copy-id root@<ip>    (ou ajoute ta clé publique à ~/.ssh/authorized_keys)"
fi
# Tunnel inverse du navigateur (BROWSER_CDP_URL) : le port doit écouter sur toutes les interfaces
# locales du VPS pour être joignable depuis les conteneurs ; ufw bloque l'extérieur.
grep -q '^GatewayPorts' /etc/ssh/sshd_config && sed -i 's/^GatewayPorts.*/GatewayPorts clientspecified/' /etc/ssh/sshd_config || echo 'GatewayPorts clientspecified' >> /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== 6. Swap 2G (les builds Next.js + Chromium en ont besoin sur 4 Go)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
fi

echo "== 7. Dépôt"
if [ -n "$GH_TOKEN" ]; then
  # Identifiants GitHub de l'utilisateur du bot : jamais dans l'URL du remote, jamais dans un log.
  sudo -u "$USER_NAME" -H bash -c "git config --global credential.helper store && umask 077 && printf 'https://x-access-token:%s@github.com\n' '$GH_TOKEN' > ~/.git-credentials"
fi
sudo -u "$USER_NAME" -H bash -c "cd ~ && [ -d manzi-junior ] || git clone ${BRANCH:+--branch '$BRANCH'} '$REPO_URL' manzi-junior"
# Dépôt déjà cloné (ré-exécution) : on bascule sur la branche demandée plutôt que de la subir.
if [ -n "$BRANCH" ]; then
  sudo -u "$USER_NAME" -H bash -c "cd ~/manzi-junior && git fetch origin '$BRANCH' && git checkout -B '$BRANCH' 'origin/$BRANCH'"
fi
sudo -u "$USER_NAME" -H bash -c "cd ~/manzi-junior && [ -f .env ] || cp .env.example .env"
sudo -u "$USER_NAME" -H bash -c "cd ~/manzi-junior && [ -f agent/mcp.json ] || cp agent/mcp.json.example agent/mcp.json"
sudo -u "$USER_NAME" -H bash -c "cd ~/manzi-junior && mkdir -p secrets backups && chmod 700 secrets"
DOCKER_GID=$(getent group docker | cut -d: -f3)
sudo -u "$USER_NAME" -H bash -c "cd ~/manzi-junior && sed -i 's/^DOCKER_GID=.*/DOCKER_GID=$DOCKER_GID/' .env"

echo "== 8. Service systemd (redémarre la stack au boot)"
cat > /etc/systemd/system/manzi.service <<EOF
[Unit]
Description=Manzi Junior autonomous agent stack
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=$USER_NAME
WorkingDirectory=/home/$USER_NAME/manzi-junior
ExecStart=/usr/bin/docker compose up -d --build --remove-orphans
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable manzi.service

cat <<EOF

Terminé. Étapes restantes (manuelles, 10 min) :
  1. su - $USER_NAME && cd manzi-junior && nano .env      # clés API (ou scp ton .env local ici)
  2. nano agent/mcp.json                             # serveurs MCP voulus
  3. Copier vos fichiers OAuth Google dans ./secrets/ (voir docs/HOSTING.md)
  4. docker compose up -d --build && docker compose logs -f orchestrator
  5. docker compose exec orchestrator node dist/cli.js veille     # premier test
EOF
