#!/usr/bin/env bash
# Rend le webhook WhatsApp auto-réparable. À lancer une fois, en root :
#
#   sudo bash deploy/whatsapp-watch-install.sh
#
# Le tunnel « quick » tire une adresse au hasard, et en retire une nouvelle à
# chaque redémarrage — du serveur, ou du seul conteneur cloudflared. Meta
# continue alors d'appeler l'ancienne : le bot devient sourd sans le dire,
# sans erreur nulle part, et on ne s'en aperçoit qu'en lui écrivant.
#
# Ce minuteur relance `whatsapp-up.sh --keep` au démarrage puis toutes les dix
# minutes. L'appel est idempotent : si l'adresse n'a pas bougé, Meta reçoit la
# même déclaration et rien ne change ; si elle a bougé, elle est redéclarée.
# Fenêtre de surdité maximale : dix minutes, au lieu d'indéfiniment.
#
# Ce n'est pas le correctif définitif — c'en est un qui ne coûte rien. Un
# tunnel nommé (CLOUDFLARE_TUNNEL_TOKEN, domaine requis) donne une adresse
# fixe ; ce minuteur reste alors utile comme contrôle de santé.
set -euo pipefail

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "à lancer en root : sudo bash deploy/whatsapp-watch-install.sh"
command -v systemctl >/dev/null 2>&1 || die "systemd absent — utilise cron : */10 * * * * bash $PWD/deploy/whatsapp-up.sh --keep"

DIR="${MANZI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
[ -f "$DIR/deploy/whatsapp-up.sh" ] || die "deploy/whatsapp-up.sh introuvable dans $DIR"

# Le service doit tourner sous le compte qui possède le dépôt : c'est lui qui
# est dans le groupe docker et qui peut lire le .env en 600.
OWNER=$(stat -c %U "$DIR")
[ -n "$OWNER" ] && [ "$OWNER" != "UNKNOWN" ] || die "impossible de déterminer le propriétaire de $DIR"

UNIT=/etc/systemd/system/manzi-whatsapp.service
TIMER=/etc/systemd/system/manzi-whatsapp.timer

cat > "$UNIT" <<EOF
[Unit]
Description=Manzi Junior - redeclare le webhook WhatsApp si l'adresse du tunnel a change
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$OWNER
WorkingDirectory=$DIR
ExecStart=/bin/bash $DIR/deploy/whatsapp-up.sh --keep
# Au demarrage, Docker peut mettre une minute a remonter la stack. Un echec
# n'est pas une panne : le passage suivant, dix minutes plus tard, reessaie.
TimeoutStartSec=300
EOF

cat > "$TIMER" <<'EOF'
[Unit]
Description=Manzi Junior - verification du webhook WhatsApp toutes les 10 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
# Rattrape le passage manque si la machine etait eteinte a l'heure prevue.
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now manzi-whatsapp.timer >/dev/null

say "minuteur installé. Prochain passage :"
systemctl list-timers manzi-whatsapp.timer --no-pager | head -3
cat <<EOF

  Journal          :  journalctl -u manzi-whatsapp.service -n 40
  Contrôle manuel  :  systemctl start manzi-whatsapp.service
  Désinstaller     :  systemctl disable --now manzi-whatsapp.timer && rm $UNIT $TIMER && systemctl daemon-reload
EOF
