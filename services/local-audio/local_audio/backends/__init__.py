from pathlib import Path
from typing import Optional

from .base import Backend, BackendError, BackendUnavailable, SfxRequest, TtsRequest, VoiceDesignRequest
from .fake import FakeBackend

BACKENDS = ("fake", "qwen-mlx")


def create_backend(name: str, fake_delay_ms: int = 0, tts_model: Optional[Path] = None) -> Backend:
    if name == "fake":
        return FakeBackend(fake_delay_ms)
    if name == "qwen-mlx":
        if tts_model is None:
            raise BackendUnavailable("the qwen-mlx backend needs --tts-model (a local Qwen3-TTS Base snapshot directory)")
        from .qwen_mlx import QwenMlxBackend  # imported only when chosen: it needs mlx-audio

        return QwenMlxBackend(tts_model)
    # A MOSS-SoundEffect backend for /sfx comes with the foley task (6.1).
    raise BackendUnavailable(f"unknown backend '{name}' (choose one of: {', '.join(BACKENDS)})")


__all__ = ["BACKENDS", "Backend", "BackendError", "BackendUnavailable", "FakeBackend", "SfxRequest", "TtsRequest", "VoiceDesignRequest", "create_backend"]
