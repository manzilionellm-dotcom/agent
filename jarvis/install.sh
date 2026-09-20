#!/usr/bin/env bash
# Jarvis — installation en une commande sur la machine qui a le micro (macOS, Linux).
#   bash jarvis/install.sh
# Installe : uv (gestionnaire Python), espeak-ng + portaudio (système), l'env Python,
# télécharge les modèles Whisper/Silero/Kokoro, crée .env et mcp.json, teste l'audio.
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\033[1;35m==> %s\033[0m\n' "$*"; }

# 1. Dépendances système ----------------------------------------------------------
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  command -v brew >/dev/null || { echo "Homebrew requis : https://brew.sh"; exit 1; }
  say "Homebrew : espeak-ng, portaudio, node"
  brew list espeak-ng >/dev/null 2>&1 || brew install espeak-ng
  brew list portaudio >/dev/null 2>&1 || brew install portaudio
  command -v node >/dev/null || brew install node
else
  say "apt : espeak-ng, portaudio, ffmpeg, node"
  sudo apt-get update -qq
  sudo apt-get install -y -qq espeak-ng libportaudio2 portaudio19-dev ffmpeg alsa-utils curl
  command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs; }
fi

# 2. uv + Python 3.12 (Kokoro exige < 3.13) --------------------------------------------
command -v uv >/dev/null || { say "Installation de uv"; curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; }
say "Environnement Python"
uv python install 3.12 >/dev/null
uv venv --python 3.12 .venv >/dev/null
uv pip install -q -e .

# 3. Config -------------------------------------------------------------------------------
mkdir -p "$HOME/.jarvis"
[ -f .env ] || { cp .env.example .env; say ".env créé — renseigne ANTHROPIC_API_KEY et ORCHESTRATOR_TOKEN"; }
[ -f mcp.json ] || cp mcp.json.example mcp.json

# 4. Modèles (téléchargés une fois, mis en cache) -------------------------------------------
say "Téléchargement des modèles (Whisper small ~500 Mo, Kokoro ~330 Mo, Silero ~2 Mo)"
.venv/bin/python - <<'EOF'
from faster_whisper import WhisperModel
WhisperModel("small", device="cpu", compute_type="int8")
from silero_vad import load_silero_vad
load_silero_vad()
from kokoro import KPipeline
p = KPipeline(lang_code="f", repo_id="hexgrad/Kokoro-82M")
for _ in p("Bonjour, je suis Jarvis.", voice="ff_siwis"):
    pass
print("modèles OK")
EOF

# 5. Test audio --------------------------------------------------------------------------------
say "Périphériques audio détectés :"
.venv/bin/jarvis --devices | head -20 || true

cat <<EOF

Jarvis est installé.
  cd $(pwd) && .venv/bin/jarvis            # mode vocal
  cd $(pwd) && .venv/bin/jarvis --text     # test clavier sans micro
Gmail/Agenda : place tes identifiants OAuth Google dans ~/.jarvis/gcp-oauth.keys.json (voir docs/JARVIS.md).
EOF
