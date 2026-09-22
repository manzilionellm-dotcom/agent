#!/usr/bin/env bash
# Rend le système autonome : il tourne sans personne devant, et se répare seul.
#
#   ssh root@50.21.190.19 'bash /home/manzi/manzi-junior/deploy/autonomie.sh'
#
# Ce que ça installe :
#   1. Docker au démarrage du serveur — sinon une coupure de courant laisse
#      tout éteint jusqu'à ce que quelqu'un se connecte.
#   2. Le gardien du webhook WhatsApp (toutes les 10 min). Indispensable ici :
#      l'adresse publique est un tunnel « quick » qui change à chaque
#      redémarrage, et sans ce gardien WhatsApp devient muet sans prévenir.
#   3. Un gardien du navigateur du serveur (toutes les 15 min) : s'il est
#      tombé, on le relance, et on remet l'orchestrateur en face de lui.
#   4. Le mode d'autonomie demandé (--scheduled pour laisser tourner les
#      missions planifiées pendant que l'opérateur dort).
#
# Tout est idempotent : relancer ne casse rien et répare ce qui a bougé.

set -uo pipefail

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m    %s\033[0m\n' "$*"; }
bad() { printf '\033[1;31m    %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "à lancer en root : ssh root@<serveur> 'bash /home/manzi/manzi-junior/deploy/autonomie.sh'"

DIR="${MANZI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$DIR"
OWNER=$(stat -c %U "$DIR")
[ -f .env ] || die "pas de .env dans $DIR"

SCHEDULED=0
for a in "$@"; do [ "$a" = "--scheduled" ] && SCHEDULED=1; done

# --- 1. Docker au démarrage --------------------------------------------------
say "Docker au démarrage du serveur"
if systemctl is-enabled docker >/dev/null 2>&1; then
  ok "déjà activé"
else
  systemctl enable docker >/dev/null 2>&1 && ok "activé" || bad "impossible d'activer docker au démarrage"
fi
# containerd aussi : docker ne démarre pas sans lui sur certaines distributions.
systemctl is-enabled containerd >/dev/null 2>&1 || systemctl enable containerd >/dev/null 2>&1 || true

# Les conteneurs doivent être en `unless-stopped`, sinon « enable docker » ne
# suffit pas : Docker démarre, et ne relance rien.
POLITIQUE=$(docker inspect -f '{{.Name}} {{.HostConfig.RestartPolicy.Name}}' $(docker ps -aq) 2>/dev/null | grep -v 'unless-stopped\|always' || true)
[ -z "$POLITIQUE" ] && ok "tous les conteneurs redémarrent seuls" || { bad "conteneurs sans redémarrage automatique :"; printf '      %s\n' "$POLITIQUE"; }

# --- 2. Gardien du webhook ---------------------------------------------------
say "Gardien du webhook WhatsApp (toutes les 10 min)"
if bash "$DIR/deploy/whatsapp-watch-install.sh" >/tmp/watch.log 2>&1; then
  ok "$(systemctl is-active manzi-whatsapp.timer 2>/dev/null || echo installé)"
else
  bad "installation impossible :"; tail -5 /tmp/watch.log | sed 's/^/      /'
fi

# --- 3. Gardien du navigateur ------------------------------------------------
say "Gardien du navigateur du serveur (toutes les 15 min)"
cat > /usr/local/bin/manzi-desktop-watch <<WATCH
#!/usr/bin/env bash
# Relance le navigateur du serveur s'il ne répond plus, et remet
# l'orchestrateur en face de lui. Lancé par un minuteur systemd.
set -uo pipefail
cd "$DIR" || exit 0
C=(docker compose -f docker-compose.yml)
[ -f docker-compose.eco.yml ] && C+=(-f docker-compose.eco.yml)

# Le navigateur répond-il DANS son conteneur ? C'est la seule question ; le
# reste (relais, réseau) se répare en relançant.
if "\${C[@]}" exec -T desktop curl -fsS --max-time 5 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  # Vivant. On vérifie seulement que l'orchestrateur vise la bonne adresse :
  # un .env modifié sans recréation laisse un processus qui regarde ailleurs.
  VU=\$("\${C[@]}" exec -T orchestrator printenv BROWSER_CDP_URL 2>/dev/null | tr -d '\\r')
  [ "\$VU" = "http://desktop:9223" ] || {
    logger -t manzi-desktop "orchestrateur sur \${VU:-rien} — recréation"
    "\${C[@]}" up -d --force-recreate orchestrator >/dev/null 2>&1
  }
  exit 0
fi

logger -t manzi-desktop "navigateur injoignable — relance"
"\${C[@]}" up -d --force-recreate desktop >/dev/null 2>&1
WATCH
chmod +x /usr/local/bin/manzi-desktop-watch

cat > /etc/systemd/system/manzi-desktop.service <<UNIT
[Unit]
Description=Surveillance du navigateur du serveur de Manzi Junior
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=$OWNER
ExecStart=/usr/local/bin/manzi-desktop-watch
UNIT

cat > /etc/systemd/system/manzi-desktop.timer <<UNIT
[Unit]
Description=Vérifie le navigateur du serveur toutes les 15 minutes

[Timer]
# 4 min après le démarrage : le temps que Docker relance la pile.
OnBootSec=4min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
if systemctl enable --now manzi-desktop.timer >/dev/null 2>&1; then
  ok "$(systemctl is-active manzi-desktop.timer)"
else
  bad "minuteur du navigateur non installé"
fi

# --- 4. Mode d'autonomie -----------------------------------------------------
MODE=$(grep -E '^AUTONOMY_MODE=' .env | head -1 | cut -d= -f2- | tr -d '"\r')
if [ "$SCHEDULED" = 1 ]; then
  say "Mode d'autonomie : missions planifiées"
  if [ "$MODE" = scheduled ]; then
    ok "déjà en scheduled"
  else
    sudo -u "$OWNER" -H bash "$DIR/deploy/set-env.sh" AUTONOMY_MODE=scheduled >/dev/null \
      && { sudo -u "$OWNER" -H docker compose -f docker-compose.yml -f docker-compose.eco.yml up -d --force-recreate orchestrator >/dev/null 2>&1; ok "passé en scheduled — les missions planifiées tourneront seules"; } \
      || bad "écriture du .env impossible"
  fi
else
  say "Mode d'autonomie : inchangé ($MODE)"
  echo "    en « manual », rien ne se lance sans ton ordre. Pour laisser tourner"
  echo "    les missions planifiées pendant que tu dors : relance avec --scheduled"
fi

# --- Vérification ------------------------------------------------------------
say "État des gardiens"
for t in manzi-whatsapp.timer manzi-desktop.timer; do
  if systemctl is-enabled "$t" >/dev/null 2>&1; then
    printf '    %-24s %s · prochaine exécution %s\n' "$t" "$(systemctl is-active "$t")" \
      "$(systemctl show "$t" -p NextElapseUSecRealtime --value 2>/dev/null | cut -d' ' -f2-3)"
  else
    bad "$t absent"
  fi
done

cat <<FIN

──────────────────────────────────────────────────────────────
  IL TOURNE SANS TOI

  Coupure de courant, serveur qui redémarre, ton PC éteint,
  toi qui dors : la pile repart seule, le webhook WhatsApp se
  redéclare, et le navigateur se relance s'il tombe.

  Tu commandes tout depuis WhatsApp, sur ton téléphone.

  Ce qui reste hors de portée d'un gardien :
    · une adresse publique jetable (tunnel « quick ») — elle
      change à chaque redémarrage ; le gardien redéclare le
      webhook, mais tout lien déjà envoyé meurt. Un tunnel
      nommé Cloudflare donne une adresse fixe.
    · une panne du fournisseur, ou un disque plein.
──────────────────────────────────────────────────────────────

FIN
