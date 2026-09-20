"""Boucle principale de Jarvis : écoute en continu → comprend → agit → répond.

    jarvis            # mode vocal
    jarvis --text     # mode clavier (test sans micro)
    jarvis --devices  # liste les périphériques audio

Latence cible sur CPU (phrase de 5 s) : VAD fin de phrase 0,8 s + Whisper small ~1 s
+ premier token Claude ~1 s + Kokoro 1re phrase 0,3 s ≈ 3 s entre la fin de ta phrase
et le début de la réponse. Sur GPU : ≈ 1,5 s.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
import threading
import time

from .config import CONFIG, Config
from .memory import Memory

STOP_WORDS = re.compile(r"^\s*(stop|stoppe|tais[- ]toi|pause|silence|chut)\b", re.I)


class Jarvis:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.memory = Memory(cfg.db_path)
        self.loop = asyncio.new_event_loop()
        self.active_until = 0.0  # fenêtre de conversation ouverte jusqu'à ce timestamp
        self.wake_re = re.compile(rf"\b{re.escape(cfg.name)}\b", re.I)
        from .brain import Brain

        self.brain = Brain(cfg, self.memory, speak_confirm=self._confirm)
        self.listener = None
        self.transcriber = None
        self.speaker = None

    # --- cycle de vie ----------------------------------------------------------------
    def run_voice(self) -> None:
        from .audio import Listener, Transcriber
        from .tts import Speaker

        print("[jarvis] chargement des modèles (Whisper, Silero, Kokoro)…")
        self.listener = Listener(self.cfg)
        self.transcriber = Transcriber(self.cfg)
        self.speaker = Speaker(self.cfg)
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self._await(self.brain.start())
        self.listener.start()
        self._say("Je suis là.")
        print(f"[jarvis] prêt — dis « {self.cfg.name} » (mode {self.cfg.wake_mode})")

        # Barge-in : si l'utilisateur parle pendant que Jarvis parle, on coupe la voix.
        threading.Thread(target=self._barge_in_watch, daemon=True).start()

        try:
            for audio in self.listener.segments():
                text = self.transcriber.transcribe(audio)
                if not text:
                    continue
                print(f"[toi] {text}")
                self._handle(text)
        except KeyboardInterrupt:
            pass
        finally:
            self.listener.stop()
            self._await(self.brain.close())

    def run_text(self) -> None:
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self._await(self.brain.start())
        print("[jarvis] mode texte — tape ta phrase (Ctrl-C pour quitter)")
        try:
            while True:
                text = input("toi> ").strip()
                if text:
                    reply = self._await(self.brain.respond(text))
                    print(f"{self.cfg.name}> {reply}")
        except (KeyboardInterrupt, EOFError):
            pass
        finally:
            self._await(self.brain.close())

    # --- logique -----------------------------------------------------------------------
    def _handle(self, text: str) -> None:
        now = time.time()
        woke = bool(self.wake_re.search(text))
        if self.cfg.wake_mode == "wake" and not woke:
            return
        if self.cfg.wake_mode == "conversation" and not woke and now > self.active_until:
            return
        if STOP_WORDS.search(text):
            self.speaker.interrupt()
            self.active_until = 0
            self._say("ok")
            return
        # Retire le nom d'éveil de la requête ("Jarvis, lance la veille" → "lance la veille").
        clean = self.wake_re.sub("", text).strip(" ,.;:!?") or "oui ?"
        self.active_until = now + self.cfg.conversation_window_s
        t0 = time.time()
        reply = self._await(self.brain.respond(clean))
        print(f"[{self.cfg.name}] ({time.time() - t0:.1f}s) {reply}")
        self._say(reply)
        self.active_until = time.time() + self.cfg.conversation_window_s

    async def _confirm(self, question: str) -> bool:
        """Confirmation vocale (uniquement pour JARVIS_CONFIRM_TOOLS)."""
        self._say(question)
        for audio in self.listener.segments():
            answer = self.transcriber.transcribe(audio).lower()
            if answer:
                return bool(re.search(r"\b(oui|ok|vas[- ]y|confirme|d'accord|yes)\b", answer))
        return False

    def _barge_in_watch(self) -> None:
        while True:
            time.sleep(0.05)
            if self.speaker and self.speaker.playing and self.listener and self.listener.speaking.is_set():
                self.speaker.interrupt()

    # --- utilitaires -------------------------------------------------------------------
    def _say(self, text: str) -> None:
        if self.speaker:
            # On n'écoute pas nos propres mots (sauf détection de barge-in par VAD, qui reste active).
            self.speaker.say(text)

    def _await(self, coro):  # noqa: ANN001, ANN202
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result()


def cli() -> None:
    p = argparse.ArgumentParser(prog="jarvis")
    p.add_argument("--text", action="store_true", help="mode clavier, sans micro")
    p.add_argument("--devices", action="store_true", help="liste les périphériques audio")
    a = p.parse_args()
    if a.devices:
        from .audio import list_devices

        print(list_devices())
        return
    j = Jarvis(CONFIG)
    if a.text or CONFIG.text_only:
        j.run_text()
    else:
        j.run_voice()


if __name__ == "__main__":
    sys.exit(cli())
