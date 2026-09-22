#!/usr/bin/env bash
# Termine l'installation de Manzi Junior. Une seule commande, SANS sudo :
#
#   bash deploy/finish.sh
#
#   bash deploy/finish.sh --rotate    # + remplace ORCHESTRATOR_TOKEN
#
# Enchaîne, dans l'ordre qui compte :
#   0. clé du coffre d'identifiants                  (avant la reconstruction :
#      l'orchestrateur lit son .env au démarrage, pas après)
#   1. mise à jour du code et reconstruction         (install.sh --eco)
#   2. jeton d'API neuf, si --rotate                 (rotate-token.sh)
#   2b. navigateur du serveur, avec écran            (desktop-up.sh)
#   3. pont vers le Chrome du poste, si root         (chrome-bridge-server.sh)
#      — facultatif désormais : le navigateur du serveur suffit
#   4. webhook WhatsApp déclaré à Meta               (whatsapp-up.sh)
#   5. surveillance du webhook toutes les 10 min     (whatsapp-watch-install.sh)
#   6. lien d'accès au coffre, à usage unique        (vault-link.sh)
#
# Chaque étape est idempotente : relancer ce script ne casse rien et répare ce
# qui a bougé. Une étape en échec n'arrête pas les suivantes quand elles sont
# indépendantes — le récapitulatif final dit ce qui est en place et ce qui ne
# l'est pas, plutôt que de s'arrêter à la première contrariété en laissant le
# reste dans un état inconnu.
set -uo pipefail

say()  { printf '\n\033[1;36m========== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m   OK  %s\033[0m\n' "$*"; }
bad()  { printf '\033[1;31m  RATE %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }

DIR="${MANZI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$DIR"
OWNER=$(stat -c %U "$DIR")
[ -n "$OWNER" ] || die "impossible de déterminer le propriétaire de $DIR"

# Root n'est PAS exigé.
#
# Deux étapes sur six en ont besoin — le pont Chrome (pare-feu, sshd) et le
# minuteur systemd. Exiger root pour l'ensemble obligeait à passer par sudo,
# donc à ressaisir un mot de passe alors que la connexion par clé était là
# précisément pour qu'on ne le redemande plus jamais. Les quatre autres
# étapes tournent sous le compte propriétaire ; les deux qui ne le peuvent
# pas sont annoncées comme sautées, avec la commande exacte pour les faire
# plus tard. Sauter en le disant vaut mieux que bloquer en le cachant.
ROOT=0; [ "$(id -u)" = 0 ] && ROOT=1
STATUS=()

# En root, on redescend sur le compte propriétaire : git, docker et le .env
# lui appartiennent, et des fichiers écrits par root dans son dépôt
# empêchent le prochain `git pull` de passer.
if [ "$ROOT" = 1 ]; then
  asowner() { sudo -u "$OWNER" -H bash -lc "cd '$DIR' && $*"; }
else
  [ "$(id -un)" = "$OWNER" ] || die "lance ce script en tant que $OWNER (propriétaire de $DIR) ou en root"
  asowner() { bash -lc "cd '$DIR' && $*"; }
fi

skip() { printf '\033[1;33m  SAUTÉ %s\033[0m\n   | %s\n' "$1" "$2"; STATUS+=("SAUTÉ $1"); }

LOGDIR=$(mktemp -d)
trap 'rm -rf "$LOGDIR"' EXIT

step() { # $1 = libellé, $2… = commande
  local label="$1"; shift
  local log="$LOGDIR/$(printf '%s' "$label" | tr -c 'A-Za-z0-9' '_')"
  say "$label"
  # Sortie affichée en direct ET conservée : une étape qui échoue après dix
  # minutes de construction a sa cause hors de l'écran, et « regarde plus
  # haut » ne sert à rien quand il n'y a plus de plus haut.
  if "$@" 2>&1 | tee "$log"; then ok "$label"; STATUS+=("OK   $label"); return 0; fi
  bad "$label"
  if [ -s "$log" ]; then
    printf '\033[1;31m   --- dernières lignes de « %s » ---\033[0m\n' "$label"
    tail -25 "$log" | sed 's/^/   | /'
  else
    printf '\033[1;31m   (aucune sortie : la commande a échoué sans rien dire)\033[0m\n'
  fi
  STATUS+=("RATE $label"); return 1
}

ROTATE=0
for a in "$@"; do [ "$a" = "--rotate" ] && ROTATE=1; done

# 0. Clé du coffre -------------------------------------------------------------
# AVANT la reconstruction, pas après : l'orchestrateur lit son .env au
# démarrage. Écrire la clé une fois qu'il tourne donne un coffre présent dans
# le fichier et absent du processus, c'est-à-dire un coffre qui refuse tout
# sans expliquer pourquoi.
if asowner "grep -qE '^VAULT_KEY=.+' .env"; then
  ok "Clé du coffre déjà en place (conservée : la changer rendrait illisibles les mots de passe enregistrés)"
  STATUS+=("OK   Clé du coffre")
else
  step "Clé du coffre" asowner "openssl rand -base64 32 | sed 's|^|VAULT_KEY=|' | bash deploy/set-env.sh --stdin" || true
fi

# 1. Code à jour et images reconstruites --------------------------------------
step "Code et images" asowner "git pull --ff-only && ./install.sh --eco" || die "reconstruction impossible : rien d'autre ne peut suivre"

# 2. Jeton d'API neuf, sur demande ---------------------------------------------
# Après la reconstruction : rotate-token.sh vérifie que l'ancien jeton est
# bien refusé, et cette vérification n'a de sens que contre le serveur final.
[ "$ROTATE" = 1 ] && { step "Jeton d'API remplacé" asowner "bash deploy/rotate-token.sh" || true; }

# 2b. Navigateur du serveur ----------------------------------------------------
# Avant le pont vers le Chrome du poste : celui-ci reste possible, mais il
# n'est plus la base. Le navigateur du serveur, lui, marche portable éteint.
step "Navigateur du serveur" asowner "bash deploy/desktop-up.sh" || true

# 3. Pont vers Chrome ----------------------------------------------------------
# Avant le webhook : ce script recrée l'orchestrateur, et on veut que la
# déclaration à Meta soit faite APRÈS le dernier redémarrage.
if [ "$ROOT" = 1 ]; then
  step "Pont vers ton Chrome" bash "$DIR/deploy/chrome-bridge-server.sh" || true
else
  skip "Pont vers ton Chrome" "demande root (pare-feu + sshd) — plus tard : ssh root@<serveur> 'bash $DIR/deploy/chrome-bridge-server.sh'"
fi
# La passerelle du pont SSH se lit sur le conteneur, jamais dans
# BROWSER_CDP_URL : depuis que l'agent pilote le navigateur du serveur, cette
# variable vaut « http://desktop:9223 », et en déduire une passerelle donnait
# la consigne « MANZI_GW='desktop' » — une adresse qui n'existe pas sur le
# poste Windows.
GW=$(docker exec manzi-sandbox sh -c "ip route 2>/dev/null | awk '/^default/ {print \$3}'" 2>/dev/null | head -1 | tr -d '\r')
[ -n "$GW" ] || GW=172.17.0.1

# 4. Webhook WhatsApp -----------------------------------------------------------
step "Webhook WhatsApp" asowner "bash deploy/whatsapp-up.sh" || true

# 5. Surveillance du webhook ------------------------------------------------------
if [ "$ROOT" = 1 ]; then
  step "Surveillance du webhook" bash "$DIR/deploy/whatsapp-watch-install.sh" || true
else
  skip "Surveillance du webhook" "demande root (minuteur systemd) — plus tard : ssh root@<serveur> 'bash $DIR/deploy/whatsapp-watch-install.sh'"
fi

# 5b. Adresse publique ---------------------------------------------------------
# Elle conditionne les liens du coffre, de l'écran, et la demande d'aide de
# l'agent. whatsapp-up.sh vient normalement de l'écrire ; ce filet la retrouve
# quand ses journaux sont muets, en lisant ce que Meta a enregistré.
step "Adresse publique" asowner "bash deploy/public-url.sh" || true

# 6. Lien vers le coffre -----------------------------------------------------
# Généré en dernier : il ne vaut que dix minutes et une seule ouverture, donc
# l'émettre avant vingt minutes de reconstruction reviendrait à l'offrir mort.
LIEN=$(asowner "bash deploy/vault-link.sh" 2>&1) || LIEN=""

# Récapitulatif --------------------------------------------------------------------
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
say "RÉCAPITULATIF"
for s in "${STATUS[@]}"; do printf '  %s\n' "$s"; done

cat <<EOF

────────────────────────────────────────────────────────────────
CE QUI TOURNE MAINTENANT

  WhatsApp     : écris au bot, il répond. Photos, captures et PDF lus.
  Missions     : « lance la veille », « crée une mission qui... »
  Agents       : rôles durables, tâches qui reprennent après un redémarrage.
  Surveillance : le webhook se redéclare seul si l'adresse du tunnel change.
  Courrier     : Gmail et Agenda, si l'autorisation Google a été donnée.
  Navigateur   : un Chromium tourne SUR LE SERVEUR, avec son propre écran.
                 Tu l'ouvres dans une page web pour t'y connecter à tes
                 comptes ; les sessions y restent, portable éteint.
                 Formulaires complets (listes, cases, fichiers), iframes,
                 onglets qui s'ouvrent seuls, téléchargements.
  Places de marché : Blocket, Tradera, Vinted, 1688, Alibaba, AliExpress,
                 Temu, Amazon · annuaires Allabolag, Hitta, Eniro, Maps
                 · emploi Platsbanken, Indeed, LinkedIn.
                 Essaie : « compare le prix de X sur blocket et sur 1688 ».

OUVRIR UNE PAGE — depuis ton PC Windows, le navigateur s'ouvre tout seul

  scp $OWNER@$IP:$DIR/deploy/ouvrir.ps1 \$HOME\\ouvrir.ps1
  & "\$HOME\\ouvrir.ps1"            tableau de bord (agents, tâches, dépense)
  & "\$HOME\\ouvrir.ps1" screen     écran du navigateur du serveur
  & "\$HOME\\ouvrir.ps1" vault      coffre d'identifiants
  & "\$HOME\\ouvrir.ps1" panel      clés d'API, consommation, plafond

  Le « & » et les guillemets ne sont pas décoratifs : PowerShell refuse de
  lancer un chemin qui commence par une variable sans son opérateur d'appel,
  et répond « Jeton inattendu » — ce qui ne dit pas qu'il manque un &.

  Depuis le serveur, si tu préfères le lien brut :
  bash deploy/vault-link.sh board|screen|vault|panel

TON COFFRE D'IDENTIFIANTS
${LIEN:-  (lien indisponible — relance : bash deploy/vault-link.sh)}

  Ce lien meurt à la première ouverture ; il ne contient aucun secret
  réutilisable. Tu y saisis tes mots de passe dans un formulaire — jamais
  dans une conversation. Le bot s'en sert sans jamais les voir.
  Un autre lien : bash deploy/vault-link.sh

IL RESTE UNE COMMANDE, SUR TON PC WINDOWS

  scp $OWNER@$IP:$DIR/deploy/chrome-bridge.ps1 \$HOME\\chrome-bridge.ps1
  \$env:MANZI_HOST='$OWNER@$IP'; \$env:MANZI_GW='${GW:-172.17.0.1}'; \$HOME\\chrome-bridge.ps1

Ferme Chrome avant : le script recopie ton profil une fois, pour que le bot
hérite de tes sessions. Ensuite, tant que cette fenêtre reste ouverte, il
voit ton Chrome. Fermée, il repasse sur son propre Chromium.

FACULTATIF — transcription des messages vocaux (clé gratuite sur console.groq.com)

  bash deploy/set-env.sh TRANSCRIBE_BASE_URL=https://api.groq.com/openai/v1 TRANSCRIBE_API_KEY=<cle>
  docker compose -f docker-compose.yml -f docker-compose.eco.yml up -d --force-recreate orchestrator
────────────────────────────────────────────────────────────────
EOF

case " ${STATUS[*]} " in *"RATE "*) exit 1 ;; esac
