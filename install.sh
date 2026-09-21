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
val() { grep -E "^$1=" .env | cut -d= -f2- | tr -d '"' ; }
PROVIDER=$(val LLM_PROVIDER); PROVIDER=${PROVIDER:-anthropic}
if [ "$PROVIDER" = "anthropic" ]; then [ -n "$(val ANTHROPIC_API_KEY)" ] && [ "$(val ANTHROPIC_API_KEY)" != "sk-ant-..." ] || missing+=(ANTHROPIC_API_KEY); fi
if [ "$PROVIDER" = "openai_compat" ]; then
  [ -n "$(val OPENAI_COMPAT_BASE_URL)" ] || missing+=(OPENAI_COMPAT_BASE_URL)
  [ -n "$(val OPENAI_COMPAT_API_KEY)" ] || missing+=(OPENAI_COMPAT_API_KEY)
  [ -n "$(val TAVILY_API_KEY)" ] || [ -n "$(val SERPAPI_API_KEY)" ] || missing+=("TAVILY_API_KEY ou SERPAPI_API_KEY")
fi
[ -n "$(val LLM_PROVIDER_CRITICAL)" ] && [ "$(val LLM_PROVIDER_CRITICAL)" = "anthropic" ] && { [ -n "$(val ANTHROPIC_API_KEY)" ] && [ "$(val ANTHROPIC_API_KEY)" != "sk-ant-..." ] || missing+=("ANTHROPIC_API_KEY (missions critiques)"); }
[ -n "$(val GITHUB_TOKEN)" ] && [ "$(val GITHUB_TOKEN)" != "github_pat_..." ] || missing+=(GITHUB_TOKEN)
WA=$(val WHATSAPP_PROVIDER); WA=${WA:-none}
if [ "$WA" = "meta" ]; then for k in WHATSAPP_PHONE_NUMBER_ID WHATSAPP_ACCESS_TOKEN WHATSAPP_APP_SECRET WHATSAPP_VERIFY_TOKEN WHATSAPP_ALLOWED_NUMBERS; do [ -n "$(val $k)" ] || missing+=($k); done; fi
if [ "$WA" = "twilio" ]; then for k in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_WHATSAPP_FROM PUBLIC_URL WHATSAPP_ALLOWED_NUMBERS; do [ -n "$(val $k)" ] || missing+=($k); done; fi
if [ $ECO = 1 ]; then [ -n "$(val CLOUDFLARE_TUNNEL_TOKEN)" ] || missing+=("CLOUDFLARE_TUNNEL_TOKEN (webhook WhatsApp, profil éco)"); fi
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
say "Construction des images (5-10 min la première fois : Chromium + Claude Code)"
"${COMPOSE[@]}" build
say "Démarrage"
"${COMPOSE[@]}" up -d --remove-orphans

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
