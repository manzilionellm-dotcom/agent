"""Voix gratuite de Manzi Junior : Kokoro (ONNX) derrière une API au format OpenAI.

Le bot parle déjà à « un service qui expose POST /audio/speech au format
OpenAI » (agent/src/voice.ts). Ce serveur en est un, qui tourne sur la
machine : zéro coût par message, aucune clé, aucune donnée qui sort.

Pourquoi ONNX et pas le Kokoro de Jarvis (PyTorch) : même modèle, mais
~380 Mo de mémoire au lieu de 1,5 Go. Le serveur « éco » a 4 Go partagés
entre la base, le navigateur et le bot ; PyTorch n'y tenait pas.

Mesuré le 26/09 : 9 s de calcul pour 7 s de parole sur un cœur partagé,
sortie OGG/Opus mono (le format des notes vocales WhatsApp), 35 ko pour
7 s. Une seule voix française existe dans Kokoro 1.0 : ff_siwis (féminine).

    GET  /v1/models        → {"data": [{"id": "kokoro"}]}   (le bouton « Tester la clé »)
    POST /v1/audio/speech  → audio ; JSON {input, voice?, speed?, response_format?}
    GET  /health           → ok
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

MODELE = os.environ.get("VOIX_MODELE", "/modeles/kokoro-v1.0.int8.onnx")
VOIX = os.environ.get("VOIX_FICHIER", "/modeles/voices-v1.0.bin")
DEFAUT = os.environ.get("VOIX_DEFAUT", "ff_siwis")
PORT = int(os.environ.get("PORT", "8880"))
MAX_TEXTE = 4_000

# La première lettre d'une voix Kokoro dit sa langue (ff_ = français féminin,
# af_ = anglais américain…). La langue de la phonétisation doit suivre, sinon
# le français est lu avec les règles de l'anglais.
LANGUES = {"f": "fr-fr", "a": "en-us", "b": "en-gb", "e": "es", "i": "it", "p": "pt-br", "h": "hi", "j": "ja", "z": "cmn"}

kokoro = Kokoro(MODELE, VOIX)
VOIX_DISPO = set(kokoro.get_voices())
# Une synthèse à la fois : deux en parallèle sur un petit serveur doublent
# le temps de chacune et la mémoire ; en file, la première arrive plus vite.
verrou = threading.Lock()


def nettoyer(texte: str) -> str:
    """Ce qui se lit mal à voix haute : markdown, adresses, emojis."""
    t = re.sub(r"https?://\S+", " le lien est dans le message ", texte)
    t = re.sub(r"[*_`#>|\[\]]", " ", t)
    t = re.sub(r"[\U0001F300-\U0001FAFF☀-➿️]", "", t)
    return re.sub(r"\s{2,}", " ", t).strip()[:MAX_TEXTE]


def synthese(texte: str, voix: str, vitesse: float, format_: str) -> tuple[bytes, str]:
    if voix not in VOIX_DISPO:
        voix = DEFAUT  # « onyx » (OpenAI) et consorts : la voix française par défaut
    langue = LANGUES.get(voix[0], "fr-fr")
    with verrou:
        pcm, sr = kokoro.create(texte, voice=voix, speed=vitesse, lang=langue)
    buf = io.BytesIO()
    if format_ == "wav":
        sf.write(buf, pcm, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue(), "audio/wav"
    # opus, ogg, et tout le reste : OGG/Opus, le format des notes vocales WhatsApp.
    sf.write(buf, pcm, sr, format="OGG", subtype="OPUS")
    return buf.getvalue(), "audio/ogg"


class Gestionnaire(BaseHTTPRequestHandler):
    server_version = "manzi-voix/1"

    def _json(self, code: int, corps: dict) -> None:
        b = json.dumps(corps).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            return self._json(200, {"object": "list", "data": [{"id": "kokoro", "object": "model"}], "voix": sorted(VOIX_DISPO)})
        if self.path == "/health":
            return self._json(200, {"ok": True})
        self._json(404, {"error": {"message": "introuvable"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in ("/v1/audio/speech", "/audio/speech"):
            return self._json(404, {"error": {"message": "introuvable"}})
        try:
            n = int(self.headers.get("content-length") or 0)
            if n > 64_000:
                return self._json(413, {"error": {"message": "requête trop grande"}})
            d = json.loads(self.rfile.read(n) or b"{}")
            texte = nettoyer(str(d.get("input", "")))
            if not texte:
                return self._json(400, {"error": {"message": "input vide"}})
            vitesse = min(2.0, max(0.5, float(d.get("speed") or 1.05)))
            debut = time.time()
            audio, mime = synthese(texte, str(d.get("voice") or DEFAUT), vitesse, str(d.get("response_format") or "opus"))
            self.send_response(200)
            self.send_header("content-type", mime)
            self.send_header("content-length", str(len(audio)))
            self.send_header("x-duree-calcul", f"{time.time() - debut:.2f}")
            self.end_headers()
            self.wfile.write(audio)
        except Exception as e:  # noqa: BLE001 — une erreur lisible vaut mieux qu'un serveur muet
            self._json(500, {"error": {"message": str(e)[:300]}})

    def log_message(self, fmt: str, *args) -> None:  # le texte dit n'est jamais journalisé
        print(f"{self.address_string()} {self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)


if __name__ == "__main__":
    print(f"voix prête sur :{PORT} — {len(VOIX_DISPO)} voix, défaut {DEFAUT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Gestionnaire).serve_forever()
