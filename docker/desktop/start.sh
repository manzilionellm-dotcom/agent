#!/usr/bin/env bash
# Démarre l'écran, le navigateur, le partage d'écran et son service HTTP.
#
# Trois processus qui dépendent l'un de l'autre dans cet ordre strict :
#   Xvfb      un écran qui n'existe que dans la mémoire du serveur
#   Chromium  dessus, avec un profil PERSISTANT (/profile, volume Docker)
#   x11vnc    partage cet écran ; websockify le sert en HTTP pour noVNC
#
# Le profil persistant est tout l'intérêt : les comptes connectés une fois
# survivent aux redémarrages du conteneur, du serveur, et à l'extinction du
# PC de l'opérateur. C'est ce qu'un navigateur sur son portable ne peut pas
# faire.

set -uo pipefail

log() { printf '[desktop] %s\n' "$*"; }

# --- Écran ------------------------------------------------------------------
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 "$SCREEN" -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB=$!

# Attendre que l'écran existe vraiment. Lancer Chromium trop tôt le fait
# mourir sans message utile, et on cherche ensuite du côté de Chromium.
for i in $(seq 1 40); do
  xdpyinfo -display :99 >/dev/null 2>&1 && break
  sleep 0.25
  [ "$i" = 40 ] && { log "Xvfb n'a pas démarré"; cat /tmp/xvfb.log; exit 1; }
done
log "écran prêt ($SCREEN)"

# --- Navigateur --------------------------------------------------------------
CHROME=$(command -v google-chrome || command -v chromium || ls /ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)
[ -n "$CHROME" ] || { log "aucun Chromium trouvé dans l'image"; exit 1; }
log "navigateur : $CHROME"

mkdir -p "$PROFILE"

# --remote-debugging-address=0.0.0.0 : nécessaire pour que l'orchestrateur
# pilote ce navigateur depuis un autre conteneur. Le port n'est PAS publié sur
# l'hôte (voir docker-compose) : il n'est joignable que depuis le réseau
# interne de la pile. Sur un poste personnel ce serait une faute ; ici c'est
# une liaison entre deux conteneurs du même serveur.
# --no-sandbox : Chromium refuse de démarrer dans un conteneur sans lui
# (zygote_host_impl_linux, crbug.com/638180). Le bac à sable de Chromium a
# besoin de privilèges que ce conteneur n'a pas, et ne doit pas avoir.
#
# Ce qu'on perd est réel : une faille de moteur de rendu n'est plus contenue
# par Chromium. Ce qu'on met à la place : le conteneur lui-même, sans
# privilèges, et un utilisateur non root. Une faille de rendu tombe donc sur
# un compte sans droits dans un conteneur isolé, au lieu de root.
"$CHROME" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --disable-session-crashed-bubble \
  --password-store=basic \
  --disable-blink-features=AutomationControlled \
  --window-position=0,0 --window-size="$(printf %s "$SCREEN" | cut -d x -f1),$(printf %s "$SCREEN" | cut -d x -f2)" \
  --start-maximized \
  --lang=fr-FR \
  "about:blank" >/tmp/chrome.log 2>&1 &
CHROME_PID=$!

for i in $(seq 1 60); do
  curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break
  sleep 0.5
  [ "$i" = 60 ] && { log "Chromium n'écoute pas sur 9222"; tail -30 /tmp/chrome.log; exit 1; }
done
log "navigateur prêt (CDP sur 9222)"

# --- Partage d'écran ---------------------------------------------------------
# Pas de mot de passe VNC : le port 5900 ne quitte jamais ce conteneur, et
# l'accès humain passe par l'orchestrateur, qui exige déjà un billet à usage
# unique. Deux mots de passe pour une porte n'ajoutent pas de sécurité, ils
# ajoutent un mot de passe de plus à perdre.
x11vnc -display :99 -forever -shared -nopw -listen 127.0.0.1 -rfbport 5900 -noxdamage -quiet >/tmp/x11vnc.log 2>&1 &
sleep 1

websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
log "écran partagé sur 6080 (noVNC)"

# --- Surveillance ------------------------------------------------------------
# Si Chromium meurt — onglet qui fait tomber le rendu, mémoire épuisée — on
# sort, et Docker relance le conteneur avec son profil intact. Rester en vie
# sans navigateur donnerait un conteneur « en bonne santé » qui ne sert à rien.
while kill -0 "$CHROME_PID" 2>/dev/null && kill -0 "$XVFB" 2>/dev/null; do sleep 5; done
log "un composant s'est arrêté — sortie pour relance"
tail -20 /tmp/chrome.log 2>/dev/null
exit 1
