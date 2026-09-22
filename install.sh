#!/usr/bin/env bash
# ============================================================================
# Manzi Junior — installation en une commande (VPS Debian/Ubuntu ou machine locale)
#
#   curl -fsSL https://raw.githubusercontent.com/manzilionellm-dotcom/agent/main/install.sh | bash
#   ou, depuis un clone :  ./install.sh [--eco] [--swarm] [--jarvis]
#   Dépôt privé : GITHUB_TOKEN=github_pat_... ./install.sh --eco  (clone + git pull authentifiés)
#
# Ce que ça fait : installe Docker si absent, clone/met à jour le dépôt,
# génère .env et mcp.json s'ils manquent (avec un token API aléatoire),
# construit et démarre la stack, lance un premier test.
# Ce que ça ne fait PAS : deviner vos clés API. Le script s'arrête et vous dit
# exactement lesquelles renseigner.
# ============================================================================
set -euo pipefail

REPO_URL="${MANZI_REPO:-https://github.com/manzilionellm-dotcom/agent.git}"
DIR="${MANZI_DIR:-$HOME/manzi-junior}"
SWARM=0; JARVIS=0; ECO=0
for a in "$@"; do case "$a" in --swarm) SWARM=1;; --jarvis) JARVIS=1;; --eco) ECO=1;; esac; done

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }

# 1. Docker --------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installation de Docker"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
  say "Docker installé. Si 'permission denied' plus bas : déconnectez/reconnectez-vous puis relancez."
fi
docker compose version >/dev/null 2>&1 || die "docker compose (plugin v2) manquant"

# 2. Dépôt --------------------------------------------------------------------
if [ -f "$(pwd)/docker-compose.yml" ] && [ -d "$(pwd)/agent" ]; then
  DIR="$(pwd)"
elif [ -d "$DIR/.git" ]; then
  say "Mise à jour de $DIR"; git -C "$DIR" pull --ff-only
else
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git config --global credential.helper store
    ( umask 077; printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > "$HOME/.git-credentials" )
  fi
  say "Clonage dans $DIR"; git clone "$REPO_URL" "$DIR"
fi
cd "$DIR"

# 3. Fichiers de config --------------------------------------------------------
mkdir -p secrets backups && chmod 700 secrets
[ -f .env ] || { cp .env.example .env; say ".env créé à partir de .env.example"; }

# Valeurs générées par la machine : remplies si vides OU encore sur le gabarit.
# (Un .env écrit à la main garde souvent « change-me… » : sans ceci, Postgres tourne
#  avec un mot de passe public et l'API locale reste désactivée.)
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
# Le `return 0` final n'est pas cosmétique. Sans lui, la fonction renvoyait le
# statut de sa dernière comparaison — fausse dès que la valeur est DÉJÀ
# renseignée — et `set -e` tuait le script à cet endroit, sans une ligne de
# sortie ni le moindre indice. L'installation ne réussissait donc que sur une
# machine neuve, où ces trois valeurs sont encore des gabarits ; tout
# redéploiement s'arrêtait net, muet, avec un simple code 1.
set_if_placeholder() { # $1 = clé, $2 = valeur, $3… = motifs considérés comme « non renseigné »
  local key="$1" val="$2"; shift 2
  local cur; cur=$(grep -E "^$key=" .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\r')
  for bad in "" "$@"; do
    if [ "$cur" = "$bad" ]; then
      if grep -qE "^$key=" .env; then sed -i.bak "s|^$key=.*|$key=$val|" .env; else printf '%s=%s\n' "$key" "$val" >> .env; fi
      rm -f .env.bak
      say "$key généré"
      return 0
    fi
  done
  return 0
}
# Un .env rédigé sous Windows arrive en CRLF. Chaque valeur récupère alors un \r
# invisible : un jeton comparé octet à octet ne correspond plus, un mot de passe
# est refusé, et l'erreur ne mentionne jamais le retour chariot. On normalise ici,
# une fois, plutôt que de laisser chaque lecteur s'en méfier.
if grep -q $'\r' .env 2>/dev/null; then
  sed -i 's/\r$//' .env
  say "Fins de ligne du .env converties en LF"
fi
set_if_placeholder POSTGRES_PASSWORD "$(rand 32)" change-me-32-chars-min change-me
set_if_placeholder ORCHESTRATOR_TOKEN "$(rand 40)"
GID=$(getent group docker 2>/dev/null | cut -d: -f3 || stat -f %g /var/run/docker.sock 2>/dev/null || echo 999)
set_if_placeholder DOCKER_GID "${GID:-999}" 999
chmod 600 .env
[ -f agent/mcp.json ] || cp agent/mcp.json.example agent/mcp.json

# 4. Clés obligatoires ---------------------------------------------------------
missing=()
val() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '"\r' ; }
# Une valeur restée sur le gabarit ne vaut pas mieux qu'une valeur vide : sans ce
# filtre l'installation va au bout et le bot meurt au premier appel d'API, avec un
# message du fournisseur que personne ne rattache au .env.
filled() {
  case "$(val "$1")" in
    "" | *A-REMPLIR* | *REMPLACE* | "sk-..." | "sk-ant-..." | "tvly-..." | "github_pat_...") return 1 ;;
    *) return 0 ;;
  esac
}
need() { filled "$1" || missing+=("${2:-$1}"); }

PROVIDER=$(val LLM_PROVIDER); PROVIDER=${PROVIDER:-anthropic}
if [ "$PROVIDER" = "anthropic" ]; then need ANTHROPIC_API_KEY; fi
if [ "$PROVIDER" = "openai_compat" ]; then
  need OPENAI_COMPAT_BASE_URL
  need OPENAI_COMPAT_API_KEY
  filled TAVILY_API_KEY || filled SERPAPI_API_KEY || missing+=("TAVILY_API_KEY ou SERPAPI_API_KEY")
fi
# `[ test ] && action` en tête de ligne sort du script sous `set -e` quand le test
# est faux : ces vérifications restent donc en `if`.
if [ "$(val LLM_PROVIDER_CRITICAL)" = "anthropic" ]; then need ANTHROPIC_API_KEY "ANTHROPIC_API_KEY (missions critiques)"; fi
need GITHUB_TOKEN
WA=$(val WHATSAPP_PROVIDER); WA=${WA:-none}
case "$WA" in
  meta)   for k in WHATSAPP_PHONE_NUMBER_ID WHATSAPP_ACCESS_TOKEN WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN WHATSAPP_ALLOWED_NUMBERS; do need "$k"; done ;;
  twilio) for k in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_WHATSAPP_FROM PUBLIC_URL WHATSAPP_ALLOWED_NUMBERS; do need "$k"; done ;;
esac
# Pas de `need CLOUDFLARE_TUNNEL_TOKEN` : le tunnel « quick » existe précisément
# pour s'en passer, et la sélection de profil plus bas sait déjà basculer dessus.
# L'exiger ici rendait impossible l'installation que ce tunnel rend possible.
if [ ${#missing[@]} -gt 0 ]; then
  printf '\nRenseignez dans %s/.env : %s\n' "$DIR" "${missing[*]}"
  printf 'Puis relancez :  cd %s && ./install.sh%s%s%s\n\n' "$DIR" "$([ $ECO = 1 ] && echo ' --eco')" "$([ $SWARM = 1 ] && echo ' --swarm')" "$([ $JARVIS = 1 ] && echo ' --jarvis')"
  exit 2
fi

# 5. Build + run ---------------------------------------------------------------
COMPOSE=(docker compose -f docker-compose.yml)
[ $ECO = 1 ] && COMPOSE+=(-f docker-compose.eco.yml)
[ $SWARM = 1 ] && COMPOSE+=(-f docker-compose.swarm.yml)
[ $ECO = 1 ] && [ $SWARM = 1 ] && die "--eco et --swarm sont incompatibles (4 Go de RAM)"
# Le tunnel Cloudflare ne sert qu'au webhook WhatsApp : il vit dans un profil Compose
# et n'est démarré que si un canal WhatsApp est configuré. Avec un jeton (donc un
# domaine), l'adresse est fixe ; sans jeton, le tunnel « quick » en tire une au
# hasard — suffisant pour brancher WhatsApp le jour même, à reconfigurer ensuite.
if [ "$WA" != "none" ]; then
  if filled CLOUDFLARE_TUNNEL_TOKEN; then COMPOSE+=(--profile tunnel); else COMPOSE+=(--profile tunnel-quick); fi
fi
say "Construction des images (5-10 min la première fois : Chromium + Claude Code)"
"${COMPOSE[@]}" build
say "Démarrage"
"${COMPOSE[@]}" up -d --remove-orphans

# Postgres ne lit POSTGRES_PASSWORD qu'à l'initialisation de son volume. À une
# réinstallation, le .env peut porter un mot de passe régénéré que la base
# existante ignore : l'orchestrateur boucle alors indéfiniment sur
# « password authentication failed », sans rapport apparent avec le .env.
# On aligne donc la base sur le .env, qui fait foi. Le socket local du conteneur
# est en `trust`, donc cet ALTER n'a pas besoin de l'ancien mot de passe.
for _ in $(seq 1 20); do "${COMPOSE[@]}" exec -T db pg_isready -U manzi -q >/dev/null 2>&1 && break; sleep 3; done
# L'erreur de psql était jetée avec `2>&1`, et le message de repli accusait
# l'initialisation de la base — une explication plausible qui masquait toutes
# les autres. On la garde et on l'affiche : c'est elle qui dit si le rôle
# manque, si le socket refuse, ou si la base n'est simplement pas prête.
# L'affectation DOIT rester dans la condition du `if` : sous `set -e`, un
# `VAR=$(commande qui échoue)` en instruction isolée sort du script.
# La commande arrive par l'entrée standard, PAS par `-c` : psql n'interpole
# pas ses variables dans `-c`, et envoyait donc `:'pw'` tel quel au serveur,
# qui répondait « syntax error at or near ":" ». L'alignement n'a donc jamais
# eu lieu depuis qu'il existe — l'erreur partait dans /dev/null.
# `:'pw'` (et non `'$pw'`) laisse psql poser les guillemets : un mot de passe
# contenant une apostrophe casserait la requête, ou pire, la détournerait.
if PG_ERR=$(printf "ALTER USER manzi WITH PASSWORD :'pw';\n" \
     | "${COMPOSE[@]}" exec -T db psql -q -v ON_ERROR_STOP=1 -U manzi -d manzi \
       -v pw="$(val POSTGRES_PASSWORD)" 2>&1); then
  say "Mot de passe Postgres aligné sur le .env"
  "${COMPOSE[@]}" restart orchestrator >/dev/null 2>&1 || true
else
  say "Postgres : alignement du mot de passe impossible"
  printf '   %s\n' "${PG_ERR:-(aucun message)}" | head -5
fi

# 6. Vérification --------------------------------------------------------------
say "Attente de l'orchestrateur"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then break; fi
  sleep 3
done
# Un « Couldn't connect to server » ne dit pas POURQUOI. La raison est dans les
# journaux de l'orchestrateur, et l'y envoyer chercher coûte un aller-retour à
# chaque panne : on les montre ici.
if ! curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
  printf '\n\033[1;31m--- l'"'"'orchestrateur ne répond pas. Ses 40 dernières lignes : ---\033[0m\n' >&2
  "${COMPOSE[@]}" logs --no-color --tail 40 orchestrator >&2 2>/dev/null || true
  die "orchestrateur injoignable sur http://127.0.0.1:8787 (voir ci-dessus)"
fi
curl -fsS http://127.0.0.1:8787/healthz | head -c 600; echo
say "Stack en ligne. Commandes utiles :"
cat <<EOF
  docker compose logs -f orchestrator                       # journal en direct
  docker compose exec orchestrator node dist/cli.js veille   # test d'une mission
  docker compose exec orchestrator node dist/cli.js report   # rapport du matin maintenant
  docker compose exec orchestrator node dist/cli.js swarm "Relever les tarifs de 10 fournisseurs et mettre à jour le comparateur"
  # \`^\` et \`tr -d '\\r'\` ne sont pas décoratifs : sans eux un .env en CRLF
  # ajoute un retour chariot au jeton et l'API répond 401 sans rien expliquer.
  curl -H "Authorization: Bearer \$(grep -E '^ORCHESTRATOR_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '"\\r')" -X POST http://127.0.0.1:8787/missions/veille
  # WhatsApp : envoie « salut » au numéro du bot ; « planifie la veille tous les jours à 5h » ; « lance l'audit du site »
EOF

# 7. Jarvis (optionnel, machine avec micro) -------------------------------------
if [ $JARVIS = 1 ]; then
  say "Installation de Jarvis (voix de Manzi Junior) (couche vocale locale)"
  bash jarvis/install.sh
fi
