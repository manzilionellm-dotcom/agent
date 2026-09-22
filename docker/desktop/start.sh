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

# --- Descente de privilèges -------------------------------------------------
#
# Le conteneur démarre en root le temps de corriger le propriétaire du profil,
# puis relance ce script sous un compte sans droits. Il ne travaille donc
# jamais en root, et on ne dépend pas de l'état d'un volume Docker existant.
#
# Pourquoi pas simplement `USER pwuser` dans l'image : un volume nommé créé
# avant ce changement appartient à root, et un conteneur non root ne peut
# alors rien y écrire. Chromium échoue sur `/profile/SingletonLock:
# Permission denied` et redémarre en boucle. Corriger ici marche quel que
# soit l'état du volume, y compris celui laissé par une version précédente.
USER_NAME=pwuser
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$PROFILE"

# Verrou d'une instance morte.
#
# Chromium pose `SingletonLock` dans le profil et y inscrit le nom de la
# machine qui l'a pris. Quand un conteneur est remplacé, ce nom désigne un
# hôte qui n'existe plus, et Chromium refuse de démarrer : « the profile
# appears to be in use by another Chromium process on another computer ».
# Il attend qu'on tranche ; personne ne peut le faire à sa place ici.
#
# Le supprimer est sûr à cet instant précis : le conteneur vient de
# démarrer, aucun Chromium n'y tourne encore, et le profil ne peut donc
# être ouvert nulle part ailleurs — il n'est monté que dans ce conteneur.
# `rm -f` sans test, et surtout PAS de `[ -e ]` : ces verrous sont des liens
# symboliques qui pointent vers « <machine>-<pid> », une cible qui n'existe
# plus. `-e` suit le lien, ne trouve rien, et répond faux — mon premier
# correctif ne supprimait donc rien du tout, en boucle.
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"
  if [ "$(stat -c %u "$PROFILE" 2>/dev/null)" != "$(id -u "$USER_NAME" 2>/dev/null)" ]; then
    log "profil appartenant à un autre compte — correction en cours"
    chown -R "$USER_NAME:$USER_NAME" "$PROFILE" || log "chown partiel : certains fichiers résistent"
  fi
  export HOME="/home/$USER_NAME"
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid="$USER_NAME" --regid="$USER_NAME" --init-groups "$0" "$@"
  fi
  exec su "$USER_NAME" -s /bin/bash -c "exec $0"
fi
log "démarrage sous $(id -un)"

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
log "navigateur prêt (CDP sur 127.0.0.1:9222)"

# --- Pilotage depuis les autres conteneurs -----------------------------------
#
# Chromium n'écoute que sur la boucle locale, et `--remote-debugging-address`
# n'y change rien de fiable selon les versions : le port répondait dans le
# conteneur et restait injoignable depuis le sandbox. Plutôt que de dépendre
# du comportement d'un drapeau, on relaie explicitement.
#
# 9223 et non 9222 : le port de débogage de Chromium reste strictement local,
# et seul ce relais est visible sur le réseau interne de la pile. Rien n'est
# publié sur l'hôte dans les deux cas.
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 >/tmp/socat.log 2>&1 &
sleep 1
if curl -fsS --max-time 3 "http://127.0.0.1:9223/json/version" >/dev/null 2>&1; then
  log "relais de pilotage prêt (9223 → 9222)"
else
  log "ATTENTION : le relais 9223 ne répond pas"
  tail -5 /tmp/socat.log 2>/dev/null
fi

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
