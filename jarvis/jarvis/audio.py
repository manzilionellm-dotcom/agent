"""Entrée audio : micro → VAD (Silero) → segments de parole → Whisper (faster-whisper).

Pipeline temps réel :
  sounddevice.InputStream (16 kHz mono, blocs de 512 échantillons = 32 ms)
    → VADIterator détecte début/fin de parole (fin = silence de END_SILENCE_MS)
    → le segment complet est transcrit par faster-whisper (CTranslate2, int8 sur CPU)

Choix de modèle Whisper (CPU, français) :
  small   : ~1 s de latence pour 5 s de parole, très bon en français, 500 Mo   ← défaut
  medium  : meilleur sur bruit/accents, 3-4 s de latence CPU
  large-v3: réservé GPU (CUDA), ~0,5 s
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Iterator

import numpy as np
import sounddevice as sd
import torch
from faster_whisper import WhisperModel
from silero_vad import VADIterator, load_silero_vad

from .config import Config

BLOCK = 512  # échantillons par bloc à 16 kHz (exigence Silero)


class Listener:
    """Itère sur des segments de parole (np.float32, 16 kHz) détectés par VAD."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._q: queue.Queue[np.ndarray] = queue.Queue()
        self._vad_model = load_silero_vad()
        self._vad = VADIterator(
            self._vad_model,
            threshold=cfg.vad_threshold,
            sampling_rate=cfg.sample_rate,
            min_silence_duration_ms=cfg.end_silence_ms,
            speech_pad_ms=120,
        )
        self.speaking = threading.Event()  # vrai pendant que l'utilisateur parle (pour le barge-in)
        self._muted = threading.Event()
        self._stream: sd.InputStream | None = None

    # --- contrôle ---------------------------------------------------------------
    def mute(self) -> None:
        """Coupe l'écoute (pendant que Jarvis parle, sauf si barge-in activé)."""
        self._muted.set()

    def unmute(self) -> None:
        self._muted.clear()
        self._vad.reset_states()

    def start(self) -> None:
        def cb(indata, frames, t, status):  # noqa: ANN001
            if status:
                pass  # xruns : on ignore, Silero est tolérant
            self._q.put(indata[:, 0].copy())

        self._stream = sd.InputStream(
            samplerate=self.cfg.sample_rate,
            channels=1,
            dtype="float32",
            blocksize=BLOCK,
            device=_device(self.cfg.input_device),
            callback=cb,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream:
            self._stream.stop()
            self._stream.close()

    # --- segments ---------------------------------------------------------------
    def segments(self) -> Iterator[np.ndarray]:
        buf: list[np.ndarray] = []
        in_speech = False
        started = 0.0
        pre_roll: list[np.ndarray] = []  # 300 ms avant le début détecté, pour ne pas couper la 1re syllabe
        while True:
            chunk = self._q.get()
            if self._muted.is_set():
                continue
            pre_roll.append(chunk)
            if len(pre_roll) > 10:
                pre_roll.pop(0)
            ev = self._vad(torch.from_numpy(chunk), return_seconds=False)
            if ev and "start" in ev and not in_speech:
                in_speech = True
                started = time.time()
                buf = list(pre_roll)
                self.speaking.set()
            if in_speech:
                buf.append(chunk)
                too_long = time.time() - started > self.cfg.max_utterance_s
                if (ev and "end" in ev) or too_long:
                    in_speech = False
                    self.speaking.clear()
                    audio = np.concatenate(buf)
                    buf = []
                    if len(audio) / self.cfg.sample_rate >= 0.4:  # < 400 ms = clic, toux
                        yield audio


class Transcriber:
    def __init__(self, cfg: Config):
        device = cfg.whisper_device
        compute = cfg.whisper_compute
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        if compute == "auto":
            compute = "float16" if device == "cuda" else "int8"
        self.cfg = cfg
        self.model = WhisperModel(cfg.whisper_model, device=device, compute_type=compute)

    def transcribe(self, audio: np.ndarray) -> str:
        segments, info = self.model.transcribe(
            audio,
            language=self.cfg.language,
            beam_size=2,
            vad_filter=False,  # déjà segmenté par Silero
            condition_on_previous_text=False,
            temperature=0.0,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        # Hallucinations classiques de Whisper sur le silence/bruit.
        if text.lower() in {"", "merci.", "merci", "sous-titres réalisés par la communauté d'amara.org", "…"}:
            return ""
        return text


def _device(name: str | None):
    if name is None:
        return None
    return int(name) if name.isdigit() else name


def list_devices() -> str:
    return str(sd.query_devices())
