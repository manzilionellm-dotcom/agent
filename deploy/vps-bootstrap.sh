#!/usr/bin/env bash
# Bootstrap d'un VPS Debian 12 / Ubuntu 24.04 vierge → Manzi Junior 24/7.
# Usage (en root) : bash vps-bootstrap.sh <utilisateur> <repo-git-url>
set -euo pipefail

USER_NAME="${1:-manzi}"
REPO_URL="${2:?URL du dépôt git}"

echo "== 1. Système"
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades git

echo "== 2. Utilisateur non-root"
id -u "$USER_NAME" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$USER_NAME"

echo "== 3. Docker (dépôt officiel)"
install -m 0755 -d /etc/apt/keyrings
. /etc/os-release
curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
usermod -aG docker "$USER_NAME"

echo "== 4. Pare-feu : SSH seulement (le bot n'expose rien)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "== 5. Durcissement SSH + mises à jour auto"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== 6. Swap 2G (les builds Next.js + Chromium en ont besoin sur 4 Go)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 7. Dépôt"
sudo -u "$USER_NAME" -H bash -c "cd ~ && [ -d manzi-junior ] || git clone '$REPO_URL' manzi-junior"
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
  1. su - $USER_NAME && cd manzi-junior && nano .env      # clés API
  2. nano agent/mcp.json                             # serveurs MCP voulus
  3. Copier vos fichiers OAuth Google dans ./secrets/ (voir docs/HOSTING.md)
  4. docker compose up -d --build && docker compose logs -f orchestrator
  5. docker compose exec orchestrator node dist/cli.js veille     # premier test
EOF
