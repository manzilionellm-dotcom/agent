# Jarvis en conteneur — LINUX UNIQUEMENT (accès micro via --device /dev/snd).
# Sur macOS/Windows, Docker n'a pas accès au micro : utiliser jarvis/install.sh (natif).
#
#   docker build -t jarvis -f jarvis/Dockerfile jarvis
#   docker run --rm -it --device /dev/snd --group-add audio \
#     -v ~/.jarvis:/root/.jarvis -v jarvis-models:/root/.cache --env-file jarvis/.env jarvis
#
# GPU NVIDIA : ajouter --gpus all et JARVIS_WHISPER_DEVICE=cuda (image de base à changer pour nvidia/cuda).
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends espeak-ng libportaudio2 alsa-utils ffmpeg curl ca-certificates git \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Torch CPU (évite 2 Go de CUDA inutiles). Pour GPU : retirer cette ligne et laisser pip résoudre.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio

WORKDIR /app
COPY pyproject.toml ./
COPY jarvis ./jarvis
RUN pip install -e .

# Pré-téléchargement des modèles dans l'image (démarrage instantané, fonctionne hors ligne).
RUN python - <<'EOF'
from faster_whisper import WhisperModel
WhisperModel("small", device="cpu", compute_type="int8")
from silero_vad import load_silero_vad
load_silero_vad()
from kokoro import KPipeline
list(KPipeline(lang_code="f", repo_id="hexgrad/Kokoro-82M")("Bonjour.", voice="ff_siwis"))
EOF

COPY mcp.json.example ./mcp.json
ENV JARVIS_MCP_CONFIG=/app/mcp.json
CMD ["jarvis"]
