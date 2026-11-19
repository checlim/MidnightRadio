from .base import Backend, BackendError, SfxRequest, TtsRequest
from .fake import FakeBackend


class BackendUnavailable(Exception):
    """The chosen backend cannot be created on this machine."""


def create_backend(name: str, fake_delay_ms: int = 0) -> Backend:
    if name == "fake":
        return FakeBackend(fake_delay_ms)
    # The real Qwen3-TTS and MOSS-SoundEffect backends are written during the Task 5.1 spike,
    # once the weights are downloaded and measured on this machine.
    raise BackendUnavailable(f"backend '{name}' is not implemented yet (see Task 5.1 in .kiro/specs/midnight-radio/tasks.md)")


__all__ = ["Backend", "BackendError", "BackendUnavailable", "FakeBackend", "SfxRequest", "TtsRequest", "create_backend"]
