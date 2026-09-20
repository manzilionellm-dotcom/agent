"""Sortie vocale : Kokoro-82M (voix féminine française `ff_siwis`), lecture en flux.

Kokoro génère phrase par phrase (~0,2-0,4 s par phrase sur CPU) ; on joue chaque
phrase dès qu'elle est prête au lieu d'attendre tout le paragraphe : la première
syllabe part en moins d'une seconde. Le barge-in (l'utilisateur coupe la parole)
arrête la lecture immédiatement.
"""

from __future__ import annotations

import queue
import re
import threading

import numpy as np
import sounddevice as sd
from kokoro import KPipeline

from .config import Config

SR = 24_000  # fréquence native de Kokoro

_SENT_SPLIT = re.compile(r"(?<=[\.\!\?…:;])\s+|\n+")


def _clean_for_speech(text: str) -> str:
    """Retire ce qui se lit mal : markdown, URL, blocs de code, emojis."""
    text = re.sub(r"```[\s\S]*?```", " (bloc de code omis) ", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"https?://\S+", " (lien) ", text)
    text = re.sub(r"[*_#>\[\]()|]", " ", text)
    text = re.sub(r"[\U0001F300-\U0001FAFF☀-➿]", "", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


class Speaker:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.pipeline = KPipeline(lang_code=cfg.kokoro_lang, repo_id="hexgrad/Kokoro-82M")
        self._stop = threading.Event()
        self._playing = threading.Event()
        self._out = _device(cfg.output_device)

    @property
    def playing(self) -> bool:
        return self._playing.is_set()

    def interrupt(self) -> None:
        self._stop.set()

    def say(self, text: str) -> None:
        """Bloquant : synthétise et joue phrase par phrase. Interruptible via interrupt()."""
        text = _clean_for_speech(text)
        if not text:
            return
        self._stop.clear()
        self._playing.set()
        chunks: queue.Queue[np.ndarray | None] = queue.Queue(maxsize=4)

        def synth() -> None:
            try:
                for sentence in (s for s in _SENT_SPLIT.split(text) if s.strip()):
                    if self._stop.is_set():
                        break
                    for _gs, _ps, audio in self.pipeline(sentence, voice=self.cfg.kokoro_voice, speed=self.cfg.kokoro_speed):
                        if self._stop.is_set():
                            break
                        arr = audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio)
                        chunks.put(arr.astype(np.float32))
            finally:
                chunks.put(None)

        threading.Thread(target=synth, daemon=True).start()
        try:
            with sd.OutputStream(samplerate=SR, channels=1, dtype="float32", device=self._out) as stream:
                while True:
                    arr = chunks.get()
                    if arr is None:
                        break
                    if self._stop.is_set():
                        break
                    # Écriture par tranches de 100 ms pour réagir vite à interrupt().
                    step = SR // 10
                    for i in range(0, len(arr), step):
                        if self._stop.is_set():
                            break
                        stream.write(arr[i : i + step].reshape(-1, 1))
        finally:
            self._playing.clear()


def _device(name: str | None):
    if name is None:
        return None
    return int(name) if name.isdigit() else name
