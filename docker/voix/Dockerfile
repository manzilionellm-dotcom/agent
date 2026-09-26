# syntax=docker/dockerfile:1
# Voix gratuite : Kokoro (ONNX), ~380 Mo de mémoire, aucune clé, rien ne sort de la machine.
# Construit par deploy/voix-gratuite.sh (profil compose « voix »).
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
# Le conteneur tourne en lecture seule : le seul endroit inscriptible est /tmp.
ENV HOME=/tmp XDG_CACHE_HOME=/tmp

# Versions figées : un modèle de voix qui change de lui-même change de voix.
RUN pip install kokoro-onnx==0.6.1 soundfile==0.14.0

# Les modèles sont dans l'image : démarrage immédiat, et aucun accès réseau
# à l'exécution (le conteneur n'a que le réseau interne).
RUN mkdir /modeles && python - <<'EOF'
import urllib.request
base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
for f in ("kokoro-v1.0.int8.onnx", "voices-v1.0.bin"):
    urllib.request.urlretrieve(base + f, "/modeles/" + f)
EOF

# Vérification au build : si la voix française ne sort pas en OGG/Opus ici,
# l'image ne se construit pas — mieux qu'un bot muet découvert plus tard.
RUN python - <<'EOF'
import io, soundfile as sf
from kokoro_onnx import Kokoro
k = Kokoro("/modeles/kokoro-v1.0.int8.onnx", "/modeles/voices-v1.0.bin")
pcm, sr = k.create("Bonjour.", voice="ff_siwis", speed=1.0, lang="fr-fr")
b = io.BytesIO(); sf.write(b, pcm, sr, format="OGG", subtype="OPUS")
assert b.getvalue()[:4] == b"OggS" and len(b.getvalue()) > 1000
print("voix française OK")
EOF

RUN useradd -r -u 10001 voix
USER voix
WORKDIR /app
COPY docker/voix/serveur.py ./
EXPOSE 8880
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8880/health', timeout=3)"
CMD ["python", "serveur.py"]
