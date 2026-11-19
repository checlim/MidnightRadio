"""Qwen3-TTS Base voice cloning on Apple Silicon, through mlx-audio.

Every line is spoken by cloning the voice's reference clip, so a character sounds the same in
every line. Delivery hints are not used yet (Task 5.1 spike, option a); they are still part of the
cache key on the TypeScript side, so adopting another option later re-renders only those lines.

Standard output carries only the service's one "listening" line, so anything the model library
prints is sent to standard error instead.

All MLX work runs on one dedicated thread: MLX ties GPU work to the thread that set it up, and the
model can only render one line at a time anyway.
"""

import contextlib
import hashlib
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from ..wav import encode_pcm16
from .base import Backend, BackendError, BackendUnavailable, SfxRequest, TtsRequest

SAMPLE_RATE = 24_000
LANGUAGE = "english"
_COMMIT = re.compile(r"^[0-9a-f]{40}$")


def file_sha256(path: Path, chunk: int = 8 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def describe_snapshot(model_dir: Path) -> tuple[str, str]:
    """(model name, revision) for a Hugging Face snapshot directory, or for any local directory."""
    resolved = model_dir.resolve()
    repo_dir = resolved.parent.parent
    if resolved.parent.name == "snapshots" and repo_dir.name.startswith("models--") and _COMMIT.match(resolved.name):
        return repo_dir.name.split("--")[-1], resolved.name
    return resolved.name, "local"


class QwenMlxBackend(Backend):
    name = "qwen-mlx"

    def __init__(self, model_dir: Path):
        self._dir = model_dir.expanduser().resolve()
        weights = self._dir / "model.safetensors"
        if not weights.is_file():
            raise BackendUnavailable(f"no model.safetensors in {self._dir}")
        config = self._dir / "config.json"
        try:
            model_type = json.loads(config.read_text(encoding="utf-8")).get("tts_model_type", "base")
        except (OSError, ValueError):
            raise BackendUnavailable(f"cannot read {config}") from None
        if model_type != "base":
            raise BackendUnavailable(f"the qwen-mlx backend clones voices, so it needs a Qwen3-TTS Base model, not '{model_type}'")

        self._model_name, self._revision = describe_snapshot(self._dir)
        self._weights_sha256 = file_sha256(weights.resolve())
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")
        self._model = self._pool.submit(self._load).result()

    def _load(self):
        try:
            from mlx_audio.tts.utils import load_model
        except ImportError:
            raise BackendUnavailable("the qwen-mlx backend needs mlx-audio (see services/local-audio/README.md)") from None
        with contextlib.redirect_stdout(sys.stderr):
            model = load_model(self._dir)
        if model.sample_rate != SAMPLE_RATE:
            raise BackendUnavailable(f"the model renders at {model.sample_rate} Hz, expected {SAMPLE_RATE}")
        return model

    def tts_info(self) -> Optional[dict]:
        return {"model": self._model_name, "revision": self._revision, "weightsSha256": self._weights_sha256, "sampleRate": SAMPLE_RATE, "ready": True}

    def sfx_info(self) -> Optional[dict]:
        return None

    def render_tts(self, request: TtsRequest) -> bytes:
        return self._pool.submit(self._render, request).result()

    def render_sfx(self, request: SfxRequest) -> bytes:
        raise BackendError("not_ready", "this backend has no sound-effect model", 503)

    def _render(self, request: TtsRequest) -> bytes:
        import mlx.core as mx
        import numpy as np

        mx.random.seed(request.seed if request.seed is not None else 0)  # same seed, same audio
        try:
            with contextlib.redirect_stdout(sys.stderr):
                results = list(self._model.generate(text=request.text, lang_code=LANGUAGE, ref_audio=str(request.clip.path), ref_text=request.clip.transcript))
        except Exception:  # noqa: BLE001 - the message from the model library is not passed on
            raise BackendError("model_failed", "the speech model could not render this line", 502) from None
        if not results or any(r.sample_rate != SAMPLE_RATE for r in results):
            raise BackendError("model_failed", "the speech model returned no audio at the expected rate", 502)
        audio = np.concatenate([np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in results])
        if audio.size == 0 or not np.isfinite(audio).all():
            raise BackendError("model_failed", "the speech model returned unusable audio", 502)
        pcm = np.round(np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
        if not pcm.any():
            raise BackendError("model_failed", "the speech model returned silence", 502)
        return encode_pcm16(pcm.tobytes(), SAMPLE_RATE)

    def close(self) -> None:
        def release() -> None:
            import mlx.core as mx

            self._model = None
            mx.clear_cache()

        self._pool.submit(release).result()
        self._pool.shutdown()
