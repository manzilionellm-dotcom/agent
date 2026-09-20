"""Configuration de Jarvis, chargée depuis l'environnement (.env à côté du dépôt)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
load_dotenv()  # .env du répertoire courant en complément


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    # --- LLM ----------------------------------------------------------------
    llm_provider: str = os.getenv("LLM_PROVIDER", "anthropic")  # anthropic | openai_compat
    anthropic_api_key: str | None = os.getenv("ANTHROPIC_API_KEY")
    openai_compat_base_url: str | None = os.getenv("OPENAI_COMPAT_BASE_URL")
    openai_compat_api_key: str | None = os.getenv("OPENAI_COMPAT_API_KEY")
    model: str = os.getenv("JARVIS_MODEL", "claude-opus-5")
    effort: str = os.getenv("JARVIS_EFFORT", "medium")

    # --- Audio ----------------------------------------------------------------
    input_device: str | None = os.getenv("JARVIS_INPUT_DEVICE")  # nom ou index sounddevice
    output_device: str | None = os.getenv("JARVIS_OUTPUT_DEVICE")
    sample_rate: int = 16_000
    vad_threshold: float = float(os.getenv("JARVIS_VAD_THRESHOLD", "0.55"))
    end_silence_ms: int = int(os.getenv("JARVIS_END_SILENCE_MS", "800"))
    max_utterance_s: int = int(os.getenv("JARVIS_MAX_UTTERANCE_S", "30"))

    # --- Whisper --------------------------------------------------------------
    whisper_model: str = os.getenv("JARVIS_WHISPER_MODEL", "small")  # tiny|base|small|medium|large-v3|distil-large-v3
    whisper_device: str = os.getenv("JARVIS_WHISPER_DEVICE", "auto")  # auto|cpu|cuda
    whisper_compute: str = os.getenv("JARVIS_WHISPER_COMPUTE", "auto")  # auto|int8|float16
    language: str = os.getenv("JARVIS_LANGUAGE", "fr")

    # --- Kokoro ---------------------------------------------------------------
    # 'f' = français. Voix féminine française : ff_siwis. Anglais féminin : af_heart, af_bella.
    kokoro_lang: str = os.getenv("JARVIS_KOKORO_LANG", "f")
    kokoro_voice: str = os.getenv("JARVIS_KOKORO_VOICE", "ff_siwis")
    kokoro_speed: float = float(os.getenv("JARVIS_KOKORO_SPEED", "1.05"))

    # --- Comportement ---------------------------------------------------------
    name: str = os.getenv("JARVIS_NAME", "Jarvis")
    # wake        : il faut dire le nom pour chaque requête
    # conversation: le nom ouvre une fenêtre de N secondes où tout est écouté (défaut)
    # always      : tout ce qui est dit est traité (attention au coût et aux faux départs)
    wake_mode: str = os.getenv("JARVIS_WAKE_MODE", "conversation")
    conversation_window_s: int = int(os.getenv("JARVIS_CONVERSATION_WINDOW_S", "45"))
    # Exécute sans demander (demande de l'opérateur). Liste d'outils qui restent en confirmation vocale :
    confirm_tools: tuple[str, ...] = tuple(t for t in os.getenv("JARVIS_CONFIRM_TOOLS", "").split(",") if t.strip())
    max_history_turns: int = int(os.getenv("JARVIS_MAX_HISTORY_TURNS", "24"))

    # --- Mémoire --------------------------------------------------------------
    db_path: Path = Path(os.getenv("JARVIS_DB", str(Path.home() / ".jarvis" / "memory.sqlite")))

    # --- Manzi Junior (orchestrateur VPS) ---------------------------------------
    orchestrator_url: str | None = os.getenv("ORCHESTRATOR_URL")  # ex: http://127.0.0.1:8787 via tunnel SSH
    orchestrator_token: str | None = os.getenv("ORCHESTRATOR_TOKEN")

    # --- MCP --------------------------------------------------------------------
    mcp_config: Path = Path(os.getenv("JARVIS_MCP_CONFIG", str(Path(__file__).resolve().parents[1] / "mcp.json")))

    # --- Divers -----------------------------------------------------------------
    text_only: bool = _bool("JARVIS_TEXT_ONLY", False)  # mode clavier (sans micro) pour tester
    debug: bool = _bool("JARVIS_DEBUG", False)
    extra: dict = field(default_factory=dict)


CONFIG = Config()
