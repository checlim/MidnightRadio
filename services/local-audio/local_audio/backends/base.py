"""What a model backend must provide. The server knows nothing about any particular model."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional



class BackendUnavailable(Exception):
    """The chosen backend cannot be created on this machine. The message says why."""


class BackendError(Exception):
    """A request the backend could not serve. `code` and `message` are safe to send to the client."""

    def __init__(self, code: str, message: str, status: int = 500):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass(frozen=True)
class TtsRequest:
    text: str
    language: str
    reference_wav: bytes
    reference_text: str
    seed: Optional[int]


@dataclass(frozen=True)
class SfxRequest:
    prompt: str
    duration_sec: float
    seed: Optional[int]


class Backend(ABC):
    name: str

    @abstractmethod
    def tts_info(self) -> Optional[dict]:
        """{'model', 'revision', 'sampleRate', 'ready'} for speech, or None if this backend has no speech model."""

    @abstractmethod
    def sfx_info(self) -> Optional[dict]:
        """Same shape for sound effects, or None."""

    @abstractmethod
    def render_tts(self, request: TtsRequest) -> bytes:
        """A complete WAV: 24 kHz, mono, 16-bit PCM."""

    @abstractmethod
    def render_sfx(self, request: SfxRequest) -> bytes:
        """A complete WAV: mono, 16-bit PCM."""

    def close(self) -> None:
        """Release models and memory."""
