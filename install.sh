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
set_if_placeholder() { # $1 = clé, $2 = valeur, $3… = motifs considérés comme « non renseigné »
  local key="$1" val="$2"; shift 2
  local cur; cur=$(grep -E "^$key=" .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\r')
  for bad in "" "$@"; do [ "$cur" = "$bad" ] && { grep -qE "^$key=" .env && sed -i.bak "s|^$key=.*|$key=$val|" .env || printf '%s=%s\n' "$key" "$val" >> .env; rm -f .env.bak; say "$key généré"; return; }; done
}
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
# Le tunnel n'existe que pour recevoir le webhook WhatsApp. Sans canal WhatsApp il
# n'y a pas de webhook : l'exiger empêchait d'installer d'abord et de brancher après.
if [ "$WA" != "none" ]; then need CLOUDFLARE_TUNNEL_TOKEN "CLOUDFLARE_TUNNEL_TOKEN (webhook WhatsApp)"; fi
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
# et n'est démarré que si un canal WhatsApp est configuré.
if [ "$WA" != "none" ]; then COMPOSE+=(--profile tunnel); fi
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
if "${COMPOSE[@]}" exec -T db psql -q -v ON_ERROR_STOP=1 -U manzi -d manzi \
     -v pw="$(val POSTGRES_PASSWORD)" -c "ALTER USER manzi WITH PASSWORD :'pw';" >/dev/null 2>&1; then
  say "Mot de passe Postgres aligné sur le .env"
  "${COMPOSE[@]}" restart orchestrator >/dev/null 2>&1 || true
else
  say "Postgres : alignement du mot de passe impossible (base peut-être encore en cours d'init)"
fi

# 6. Vérification --------------------------------------------------------------
say "Attente de l'orchestrateur"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then break; fi
  sleep 3
done
curl -fsS http://127.0.0.1:8787/healthz | head -c 600; echo
say "Stack en ligne. Commandes utiles :"
cat <<EOF
  docker compose logs -f orchestrator                       # journal en direct
  docker compose exec orchestrator node dist/cli.js veille   # test d'une mission
  docker compose exec orchestrator node dist/cli.js report   # rapport du matin maintenant
  docker compose exec orchestrator node dist/cli.js swarm "Relever les tarifs de 10 fournisseurs et mettre à jour le comparateur"
  curl -H "Authorization: Bearer \$(grep ORCHESTRATOR_TOKEN .env | cut -d= -f2)" -X POST http://127.0.0.1:8787/missions/veille
  # WhatsApp : envoie « salut » au numéro du bot ; « planifie la veille tous les jours à 5h » ; « lance l'audit du site »
EOF

# 7. Jarvis (optionnel, machine avec micro) -------------------------------------
if [ $JARVIS = 1 ]; then
  say "Installation de Jarvis (voix de Manzi Junior) (couche vocale locale)"
  bash jarvis/install.sh
fi
