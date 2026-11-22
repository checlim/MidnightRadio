#!/usr/bin/env python3
"""Speech service (API version 1) for a Kaggle GPU notebook, backed by Qwen3-TTS voice cloning.

Self-contained: standard library plus `qwen-tts`, `torch`, `numpy` and `huggingface_hub`
(the last three are imported lazily, only by the model adapter and `bench`). It imports nothing
from the Midnight Radio repository and knows nothing about voices or catalogues: every `/tts`
request carries its own reference clip. The contract is `docs/tts-service-api.md`.

    python qwen_tts_server.py serve --port 8765 [--dtype float32] [--attn sdpa] [--device cuda:0]
                                    [--model-dir DIR] [--design-device cuda:1|none]
                                    [--design-dtype float32] [--design-model-dir DIR]
    python qwen_tts_server.py bench --reference clip.wav --reference-text "..." [--out ./bench]
                                    [--design "<voice description>"]

Security
- The access token comes only from the environment variable TTS_SERVICE_TOKEN (at least 16
  characters); the server refuses to start without it. It is required on every endpoint,
  including /health, and compared in constant time. It is never logged.
- Listens on 127.0.0.1 only; expose it through a tunnel. The Host header is NOT checked (a tunnel
  rewrites it), but any request carrying an Origin header (a browser page) is refused.
- Logs hold the method, path and status only, never bodies, headers, request text or tokens.

Precision
- The default dtype is float32 because a Kaggle T4 has no native bfloat16 (it is emulated and slow)
  and float16 can produce noise in this model. Pick `--dtype float16` only after listening to
  the `bench` WAVs. bfloat16 suits Ampere or newer GPUs.
- `/health` reports the dtype in `tts.dtype`. When the dtype is not bfloat16 the reported `model`
  string carries it, e.g. "Qwen3-TTS-12Hz-1.7B-Base (float32)", so audio rendered at different
  precision never shares a client cache entry.

Model
- Pinned to Qwen/Qwen3-TTS-12Hz-1.7B-Base at REVISION. Without `--model-dir` that exact revision is
  downloaded with huggingface_hub. The SHA-256 of model.safetensors is computed at start-up and
  reported as `weightsSha256`; a different hash prints a warning.
- The model loads in a background thread. /health answers ready=false and /tts answers 503
  not_ready until it is loaded.
- A second pinned model, Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign at DESIGN_REVISION, serves
  POST /voice-design (it turns a written voice description into a reference clip). It loads in its
  own background thread, is reported as `voiceDesign` in /health (null when disabled with
  `--design-device none`) and answers 503 not_ready until it is loaded. Each model has its own lock,
  so a design and a clone can run at the same time on two GPUs; models on the same device share one.

Benchmark reference: the Mac (MLX) measured 118 ms per character.
"""

from __future__ import annotations

import argparse
import array
import base64
import binascii
import collections
import dataclasses
import hashlib
import hmac
import io
import json
import logging
import math
import os
import statistics
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Optional

API_VERSION = 1
SERVICE_NAME = "qwen-tts-kaggle"
REPO_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
MODEL_NAME = "Qwen3-TTS-12Hz-1.7B-Base"
REVISION = "fd4b254389122332181a7c3db7f27e918eec64e3"
EXPECTED_WEIGHTS_SHA256 = "38fc7fc51c5e776e840414b6fd443962e9411b9654888fd7913e4da643cb857c"
DESIGN_REPO_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
DESIGN_MODEL_NAME = "Qwen3-TTS-12Hz-1.7B-VoiceDesign"
DESIGN_REVISION = "5ecdb67327fd37bb2e042aab12ff7391903235d3"
DESIGN_EXPECTED_WEIGHTS_SHA256 = "391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522"
SAMPLE_RATE = 24000
TOKEN_ENV = "TTS_SERVICE_TOKEN"
MIN_TOKEN_CHARS = 16

MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_DESIGN_BODY_BYTES = 64 * 1024
MAX_DESIGN_CHARS = 500
DESIGN_OFF = "none"
BENCH_DESIGN_TEXT = "Good evening. The night is cold, the road is long, and the old house waits at the end of it."
MAX_TEXT_CHARS = 4000
MAX_REF_TEXT_CHARS = 500
MAX_REF_SECONDS = 30
MAX_LANGUAGE_CHARS = 40
MAX_SEED = 2**31 - 1
PROMPT_CACHE_SIZE = 64
DTYPES = ("float32", "float16", "bfloat16")
ATTNS = ("sdpa", "eager", "flash_attention_2")

log = logging.getLogger("qwen_tts_server")


# --- errors -------------------------------------------------------------------------------------


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class ConfigError(Exception):
    pass


class OutOfMemory(Exception):
    """The GPU ran out of memory; the adapter has already freed its cache."""


class RenderFailed(Exception):
    """The model could not produce usable audio for this line."""


# --- configuration ------------------------------------------------------------------------------


@dataclasses.dataclass
class Config:
    token: str
    port: int = 8765
    dtype: str = "float32"
    attn: str = "sdpa"
    device: str = "cuda:0"
    model_dir: Optional[str] = None
    host: str = "127.0.0.1"
    queue_timeout_s: float = 120.0
    design_device: Optional[str] = None  # None: the same device as `device`; "none": no voice design
    design_dtype: Optional[str] = None  # None: the same as `dtype`
    design_model_dir: Optional[str] = None
    @property
    def design_enabled(self) -> bool:
        return (self.design_device or "").lower() != DESIGN_OFF
    @property
    def effective_design_device(self) -> str:
        return self.design_device or self.device
    @property
    def effective_design_dtype(self) -> str:
        return self.design_dtype or self.dtype


def validate_token(token: Optional[str]) -> str:
    if token is None or len(token) < MIN_TOKEN_CHARS:
        raise ConfigError(f"set {TOKEN_ENV} in the environment to a token of at least {MIN_TOKEN_CHARS} characters")
    return token


def reported_model_name(dtype: str) -> str:
    return MODEL_NAME if dtype == "bfloat16" else f"{MODEL_NAME} ({dtype})"


def reported_design_model_name(dtype: str) -> str:
    return DESIGN_MODEL_NAME if dtype == "bfloat16" else f"{DESIGN_MODEL_NAME} ({dtype})"
def resolve_design_device(value: Optional[str], device: str) -> str:
    """The design device: the given one, else cuda:1 when a second GPU exists, else the main device."""
    if value is not None:
        return value
    try:
        import torch
        if torch.cuda.device_count() > 1:
            return "cuda:1"
    except Exception:  # noqa: BLE001 - no torch or no CUDA: share the main device
        pass
    return device
# --- reference clip and output WAV (standard library only) ---------------------------------------


@dataclasses.dataclass
class Reference:
    samples: "array.array"  # float32 in [-1, 1)
    sample_rate: int
    key: str  # sha256 of the clip bytes and its transcript


def parse_reference(wav_bytes: bytes, text: str) -> Reference:
    """Validate a reference clip: PCM 16-bit mono WAV of at most 30 seconds."""
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as w:
            channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            if channels != 1 or width != 2:
                raise HttpError(400, "bad_request", "the reference must be a mono 16-bit PCM WAV")
            if rate < 8000 or rate > 96000 or frames <= 0:
                raise HttpError(400, "bad_request", "the reference WAV has an unusable sample rate or no audio")
            if frames / rate > MAX_REF_SECONDS:
                raise HttpError(400, "bad_request", f"the reference is limited to {MAX_REF_SECONDS} seconds")
            pcm = w.readframes(frames)
    except (wave.Error, EOFError):
        raise HttpError(400, "bad_request", "the reference is not a usable WAV file") from None
    if len(pcm) != frames * 2:
        raise HttpError(400, "bad_request", "the reference WAV is truncated")
    ints = array.array("h")
    ints.frombytes(pcm)
    if sys.byteorder == "big":
        ints.byteswap()
    samples = array.array("f", (v / 32768.0 for v in ints))
    key = hashlib.sha256(wav_bytes + b"\x00" + text.encode("utf-8")).hexdigest()
    return Reference(samples, rate, key)


def encode_wav(samples: Any, sample_rate: int) -> bytes:
    """Float samples in [-1, 1] to a 24 kHz mono 16-bit WAV. Refuses empty, non-finite or silent audio."""
    values = samples.tolist() if hasattr(samples, "tolist") else list(samples)
    if values and isinstance(values[0], list):
        raise RenderFailed("multi-channel audio")
    if sample_rate != SAMPLE_RATE:
        raise RenderFailed("unexpected sample rate")
    if not values:
        raise RenderFailed("empty audio")
    pcm = array.array("h")
    peak = 0
    for v in values:
        f = float(v)
        if not math.isfinite(f):
            raise RenderFailed("non-finite audio")
        q = int(round(max(-1.0, min(1.0, f)) * 32767))
        pcm.append(q)
        peak = max(peak, abs(q))
    if peak == 0:
        raise RenderFailed("silent audio")
    if sys.byteorder == "big":
        pcm.byteswap()
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return out.getvalue()


def wav_seconds(wav_bytes: bytes) -> float:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return w.getnframes() / w.getframerate()


# --- renderer: prompt cache + model adapter ------------------------------------------------------


@dataclasses.dataclass
class LoadedModel:
    """What a model loader returns. `adapter` needs create_prompt() and generate() (see QwenAdapter)."""

    adapter: Any
    revision: str
    weights_sha256: str


class Renderer:
    """Not thread-safe by itself: callers hold the model lock."""

    def __init__(self, adapter: Any, cache_size: int = PROMPT_CACHE_SIZE):
        self.adapter = adapter
        self.cache_size = cache_size
        self.prompts: "collections.OrderedDict[str, Any]" = collections.OrderedDict()

    def render(self, text: str, language: str, seed: int, ref: Reference, ref_text: str) -> bytes:
        prompt = self.prompts.get(ref.key)
        if prompt is None:
            prompt = self._guard(lambda: self.adapter.create_prompt(ref.samples, ref.sample_rate, ref_text))
            self.prompts[ref.key] = prompt
            while len(self.prompts) > self.cache_size:
                self.prompts.popitem(last=False)
        else:
            self.prompts.move_to_end(ref.key)
        samples, rate = self._guard(lambda: self.adapter.generate(text, language, prompt, seed))
        return encode_wav(samples, rate)

    @staticmethod
    def _guard(call: Callable[[], Any]) -> Any:
        try:
            return call()
        except (OutOfMemory, RenderFailed):
            raise
        except Exception as err:  # noqa: BLE001 - details may contain the request; keep only the type
            raise RenderFailed(type(err).__name__) from None


class DesignRenderer:
    """Not thread-safe by itself: callers hold the design model lock."""
    def __init__(self, adapter: Any):
        self.adapter = adapter
    def render(self, instruct: str, text: str, language: str, seed: int) -> bytes:
        samples, rate = Renderer._guard(lambda: self.adapter.generate_design(instruct, text, language, seed))
        return encode_wav(samples, rate)
# --- the real model (torch, numpy and qwen-tts are imported here, lazily) ---------------------------


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def revision_of(model_dir: Path, default: str = REVISION) -> str:
    parts = model_dir.resolve().parts
    for i, part in enumerate(parts[:-1]):
        if part == "snapshots":
            return parts[i + 1]
    return default


class QwenAdapter:
    def __init__(self, model: Any, torch: Any, np: Any):
        self.model, self.torch, self.np = model, torch, np

    def create_prompt(self, samples: Any, sample_rate: int, ref_text: str) -> Any:
        audio = self.np.asarray(samples, dtype=self.np.float32)
        with self._memory_guard():
            with self.torch.inference_mode():
                return self.model.create_voice_clone_prompt(ref_audio=(audio, sample_rate), ref_text=ref_text, x_vector_only_mode=False)

    def generate(self, text: str, language: str, prompt: Any, seed: int) -> Any:
        return self._run(seed, lambda: self.model.generate_voice_clone(text=text, language=language, voice_clone_prompt=prompt))
    def generate_design(self, instruct: str, text: str, language: str, seed: int) -> Any:
        return self._run(seed, lambda: self.model.generate_voice_design(text=text, language=language, instruct=instruct))
    def _run(self, seed: int, call: Callable[[], Any]) -> Any:
        torch = self.torch
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        with self._memory_guard():
            with torch.inference_mode():
                wavs, rate = call()
        wav = wavs[0]
        if hasattr(wav, "detach"):
            wav = wav.detach().cpu().float().numpy()
        return self.np.asarray(wav, dtype=self.np.float32).reshape(-1), rate

    def _memory_guard(self) -> Any:
        torch = self.torch

        class Guard:
            def __enter__(self) -> None:
                return None

            def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
                if exc_type is not None and issubclass(exc_type, torch.cuda.OutOfMemoryError):
                    torch.cuda.empty_cache()
                    raise OutOfMemory() from None
                return False

        return Guard()


def _load_pinned(repo_id: str, revision: str, expected_sha: str, model_dir: Optional[str], dtype: str, attn: str, device: str) -> LoadedModel:
    import numpy as np
    import torch
    from qwen_tts import Qwen3TTSModel
    if model_dir:
        path = Path(model_dir)
    else:
        from huggingface_hub import snapshot_download
        log.info("downloading %s at %s", repo_id, revision)
        path = Path(snapshot_download(repo_id=repo_id, revision=revision))
    weights = path / "model.safetensors"
    if not weights.is_file():
        raise RuntimeError("model.safetensors not found in the model directory")
    log.info("hashing model.safetensors of %s", repo_id)
    weights_sha = sha256_file(weights)
    if weights_sha != expected_sha:
        log.warning("WARNING: model.safetensors hash %s of %s differs from the expected %s", weights_sha, repo_id, expected_sha)
    resolved = revision_of(path, revision)
    log.info("loading %s (%s, %s, %s)", repo_id, dtype, attn, device)
    model = Qwen3TTSModel.from_pretrained(str(path), device_map=device, dtype=getattr(torch, dtype), attn_implementation=attn)
    return LoadedModel(QwenAdapter(model, torch, np), resolved, weights_sha)
def load_real_model(config: Config) -> LoadedModel:
    return _load_pinned(REPO_ID, REVISION, EXPECTED_WEIGHTS_SHA256, config.model_dir, config.dtype, config.attn, config.device)
def load_real_design_model(config: Config) -> LoadedModel:
    return _load_pinned(DESIGN_REPO_ID, DESIGN_REVISION, DESIGN_EXPECTED_WEIGHTS_SHA256, config.design_model_dir, config.effective_design_dtype, config.attn, config.effective_design_device)
# --- HTTP server -------------------------------------------------------------------------------


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    def __init__(
        self,
        config: Config,
        load_model: Callable[[Config], LoadedModel] = load_real_model,
        load_design_model: Callable[[Config], LoadedModel] = load_real_design_model,
    ):
        validate_token(config.token)
        super().__init__((config.host, config.port), _Handler)
        self.config = config
        self.load_model = load_model
        self.load_design_model = load_design_model
        self.model_lock = threading.Lock()
        # Two GPUs can work at once; two models on one device must not.
        same_device = config.effective_design_device == config.device
        self.design_lock = self.model_lock if same_device else threading.Lock()
        self.renderer: Optional[Renderer] = None
        self.revision = REVISION
        self.weights_sha256: Optional[str] = None
        self.loaded = threading.Event()
        self.load_failed = False
        self.design_renderer: Optional[DesignRenderer] = None
        self.design_revision = DESIGN_REVISION
        self.design_weights_sha256: Optional[str] = None
        self.design_loaded = threading.Event()
        self.design_load_failed = False
    @property
    def port(self) -> int:
        return self.server_address[1]
    @property
    def ready(self) -> bool:
        return self.loaded.is_set() and self.renderer is not None
    @property
    def design_ready(self) -> bool:
        return self.config.design_enabled and self.design_loaded.is_set() and self.design_renderer is not None
    def start_loading(self) -> threading.Thread:
        """Starts one loader thread per model; returns the speech one."""
        if self.config.design_enabled:
            threading.Thread(target=self._load_design, name="design-model-loader", daemon=True).start()
        thread = threading.Thread(target=self._load, name="model-loader", daemon=True)
        thread.start()
        return thread
    def _load(self) -> None:
        try:
            loaded = self.load_model(self.config)
            self.revision, self.weights_sha256 = loaded.revision, loaded.weights_sha256
            self.renderer = Renderer(loaded.adapter)
            self.loaded.set()
            log.info("model ready")
        except Exception as err:  # noqa: BLE001
            self.load_failed = True
            log.error("model failed to load: %s", type(err).__name__)
    def _load_design(self) -> None:
        try:
            loaded = self.load_design_model(self.config)
            self.design_revision, self.design_weights_sha256 = loaded.revision, loaded.weights_sha256
            self.design_renderer = DesignRenderer(loaded.adapter)
            self.design_loaded.set()
            log.info("voice-design model ready")
        except Exception as err:  # noqa: BLE001
            self.design_load_failed = True
            log.error("voice-design model failed to load: %s", type(err).__name__)
    def tts_info(self) -> dict:
        return {
            "model": reported_model_name(self.config.dtype),
            "revision": self.revision,
            "weightsSha256": self.weights_sha256,
            "sampleRate": SAMPLE_RATE,
            "dtype": self.config.dtype,
            "ready": self.ready,
        }
    def design_info(self) -> Optional[dict]:
        if not self.config.design_enabled:
            return None
        dtype = self.config.effective_design_dtype
        return {
            "model": reported_design_model_name(dtype),
            "revision": self.design_revision,
            "weightsSha256": self.design_weights_sha256,
            "sampleRate": SAMPLE_RATE,
            "dtype": dtype,
            "ready": self.design_ready,
        }
class _Handler(BaseHTTPRequestHandler):
    server: Server
    server_version = SERVICE_NAME
    sys_version = ""
    timeout = 120

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def _finish(self, status: int) -> None:
        log.info("%s %s -> %d", self.command, self.path.split("?", 1)[0], status)

    def _send(self, status: int, body: bytes, content_type: str, extra: Optional[dict] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)
        self._finish(status)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

    def _error(self, err: HttpError) -> None:
        self._json(err.status, {"error": {"code": err.code, "message": err.message}})

    def _check_caller(self) -> None:
        if self.headers.get("Origin") is not None:
            raise HttpError(403, "bad_origin", "browser requests are not accepted")
        header = self.headers.get("Authorization") or ""
        supplied = header[7:] if header[:7].lower() == "bearer " else ""
        if not hmac.compare_digest(supplied.encode("utf-8"), self.server.config.token.encode("utf-8")):
            raise HttpError(401, "unauthorized", "a valid access token is required")

    def _read_json(self, max_bytes: int = MAX_BODY_BYTES) -> dict:
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            raise HttpError(415, "unsupported_media_type", "send application/json")
        if self.headers.get("Transfer-Encoding") is not None:
            raise HttpError(411, "length_required", "send a Content-Length, not a chunked body")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isascii() or not raw_length.isdigit():
            raise HttpError(411, "length_required", "send a Content-Length")
        length = int(raw_length)
        if length > max_bytes:
            limit = f"{max_bytes // (1024 * 1024)} MB" if max_bytes >= 1024 * 1024 else f"{max_bytes // 1024} KB"
            raise HttpError(413, "too_large", f"requests are limited to {limit}")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise HttpError(400, "bad_request", "the body is not valid JSON") from None
        if not isinstance(body, dict):
            raise HttpError(400, "bad_request", "the body must be a JSON object")
        return body

    def _route(self, method: str) -> None:
        path = self.path.split("?", 1)[0]
        routes = {"/health": "GET", "/tts": "POST", "/voice-design": "POST"}
        if path not in routes:
            raise HttpError(404, "not_found", "no such endpoint")
        if routes[path] != method:
            raise HttpError(405, "method_not_allowed", f"use {routes[path]}")
        self._check_caller()
        if path == "/health":
            return self._json(200, {"service": SERVICE_NAME, "apiVersion": API_VERSION, "tts": self.server.tts_info(), "voiceDesign": self.server.design_info()})
        if path == "/voice-design":
            return self._design(self._read_json(MAX_DESIGN_BODY_BYTES))
        self._tts(self._read_json())

    def _tts(self, body: dict) -> None:
        unknown = sorted(set(body) - {"text", "language", "seed", "reference"})
        if unknown:
            raise HttpError(400, "bad_request", f"unknown field '{unknown[0]}'")
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise HttpError(400, "bad_request", "text must not be blank")
        if len(text) > MAX_TEXT_CHARS:
            raise HttpError(400, "bad_request", f"text is limited to {MAX_TEXT_CHARS} characters")
        language = body.get("language")
        if not isinstance(language, str) or not language.strip() or len(language) > MAX_LANGUAGE_CHARS:
            raise HttpError(400, "bad_request", "language must be a short, non-empty string")
        seed = body.get("seed")  # required: the client always sends its fixed seed, so renders repeat
        if not _is_int(seed) or not 0 <= seed <= MAX_SEED:
            raise HttpError(400, "bad_request", "seed must be an integer from 0 to 2147483647")
        reference = body.get("reference")
        if not isinstance(reference, dict):
            raise HttpError(400, "bad_request", "reference must be an object")
        extra = sorted(set(reference) - {"audio", "text"})
        if extra:
            raise HttpError(400, "bad_request", f"unknown field 'reference.{extra[0]}'")
        ref_text = reference.get("text")
        if not isinstance(ref_text, str) or not ref_text.strip() or len(ref_text) > MAX_REF_TEXT_CHARS:
            raise HttpError(400, "bad_request", f"reference.text must be 1 to {MAX_REF_TEXT_CHARS} characters")
        audio = reference.get("audio")
        if not isinstance(audio, str) or not audio:
            raise HttpError(400, "bad_request", "reference.audio must be a base64 string")
        try:
            wav_bytes = base64.b64decode(audio, validate=True)
        except (binascii.Error, ValueError):
            raise HttpError(400, "bad_request", "reference.audio is not valid base64") from None
        ref = parse_reference(wav_bytes, ref_text)
        if not self.server.ready:
            raise HttpError(503, "not_ready", "the model is still loading" if not self.server.load_failed else "the model failed to load")
        self._render_locked(self.server.model_lock, lambda: self.server.renderer.render(text, language, seed, ref, ref_text), self.server.revision)  # type: ignore[union-attr]
    def _design(self, body: dict) -> None:
        if set(body) - {"instruct", "text", "language", "seed"}:  # the name is not echoed: it comes from the request
            raise HttpError(400, "bad_request", "the request has a field this API does not define")
        for field in ("instruct", "text"):
            value = body.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > MAX_DESIGN_CHARS:
                raise HttpError(400, "bad_request", f"{field} must be 1 to {MAX_DESIGN_CHARS} characters")
        language = body.get("language")
        if not isinstance(language, str) or not language.strip() or len(language) > MAX_LANGUAGE_CHARS:
            raise HttpError(400, "bad_request", "language must be a short, non-empty string")
        seed = body.get("seed")
        if not _is_int(seed) or not 0 <= seed <= MAX_SEED:
            raise HttpError(400, "bad_request", "seed must be an integer from 0 to 2147483647")
        server = self.server
        if not server.config.design_enabled:
            raise HttpError(503, "not_ready", "this server has no voice-design model")
        if not server.design_ready:
            raise HttpError(503, "not_ready", "the voice-design model is still loading" if not server.design_load_failed else "the voice-design model failed to load")
        instruct, text = body["instruct"], body["text"]
        self._render_locked(server.design_lock, lambda: server.design_renderer.render(instruct, text, language, seed), server.design_revision)  # type: ignore[union-attr]
    def _render_locked(self, lock: threading.Lock, render: Callable[[], bytes], revision: str) -> None:
        if not lock.acquire(timeout=self.server.config.queue_timeout_s):
            raise HttpError(503, "busy", "the model is busy; try again")
        started = time.monotonic()
        try:
            wav = render()
        except OutOfMemory:
            raise HttpError(503, "busy", "the GPU is out of memory; try again") from None
        except RenderFailed as err:
            log.error("render failed: %s", err)
            raise HttpError(502, "model_failed", "the model could not render this line") from None
        finally:
            lock.release()
        self._send(200, wav, "audio/wav", {"X-Model-Revision": revision, "X-Render-Ms": str(round((time.monotonic() - started) * 1000))})
    def _handle(self, method: str) -> None:
        try:
            self._route(method)
        except HttpError as err:
            self._error(err)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as err:  # noqa: BLE001 - never leak details or the request
            log.error("%s %s failed: %s", self.command, self.path.split("?", 1)[0], type(err).__name__)
            self._error(HttpError(500, "internal", "the service failed to handle the request"))

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    do_DELETE = do_PATCH = do_PUT  # noqa: N815


# --- bench -------------------------------------------------------------------------------------

BENCH_LINES = [
    ("short", "The door is open."),
    ("medium", "Good evening, and welcome to the house on the hill. Please, come in out of the cold."),
    (
        "long",
        "They say the old house has stood empty for a hundred years, but tonight a single light burns in the "
        "highest window, and somewhere below, a clock begins to strike a very long hour.",
    ),
]


def run_bench(
    config: Config,
    reference_path: str,
    reference_text: str,
    out_dir: str,
    load_model: Callable[[Config], LoadedModel] = load_real_model,
    design: Optional[str] = None,
    load_design_model: Callable[[Config], LoadedModel] = load_real_design_model,
) -> float:
    if design is not None and not config.design_enabled:
        raise ConfigError("--design needs a voice-design model; do not pass --design-device none")
    ref = parse_reference(Path(reference_path).read_bytes(), reference_text)
    loaded = load_model(config)
    renderer = Renderer(loaded.adapter)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    per_char: list[float] = []
    print(f"{'line':8} {'chars':>5} {'ms':>9} {'ms/char':>8} {'RTF':>6}")
    for name, text in BENCH_LINES:
        for attempt in (1, 2):  # the first run is a warm-up
            started = time.monotonic()
            wav = renderer.render(text, "English", 0, ref, reference_text)
            ms = (time.monotonic() - started) * 1000
            tag = "warm-up" if attempt == 1 else ""
            print(f"{name:8} {len(text):5d} {ms:9.0f} {ms / len(text):8.1f} {ms / 1000 / wav_seconds(wav):6.2f} {tag}")
            if attempt == 2:
                per_char.append(ms / len(text))
                (out / f"bench-{name}.wav").write_bytes(wav)
    median = statistics.median(per_char)
    if design is not None:
        designer = DesignRenderer(load_design_model(config).adapter)
        started = time.monotonic()
        wav = designer.render(design, BENCH_DESIGN_TEXT, "English", 0)
        ms = (time.monotonic() - started) * 1000
        (out / "bench-design.wav").write_bytes(wav)
        print(f"voice design: {ms:.0f} ms for {wav_seconds(wav):.1f} s of audio (includes any warm-up); saved bench-design.wav")
    gpu = "unknown GPU"
    try:
        import torch

        gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"
    except Exception:  # noqa: BLE001
        pass
    print(f"median {median:.0f} ms/char at dtype {config.dtype} on {gpu} (the Mac measured 118 ms/char); WAVs in {out}")
    return median


# --- CLI ---------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Qwen3-TTS speech service for a Kaggle GPU")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--dtype", choices=DTYPES, default="float32")
        p.add_argument("--attn", choices=ATTNS, default="sdpa")
        p.add_argument("--device", default="cuda:0")
        p.add_argument("--model-dir", default=None)
        p.add_argument("--design-device", default=None, help="device for the VoiceDesign model (default: cuda:1 if two GPUs, else --device); 'none' turns voice design off")
        p.add_argument("--design-dtype", choices=DTYPES, default=None, help="default: --dtype")
        p.add_argument("--design-model-dir", default=None, help="local VoiceDesign snapshot (default: download the pinned revision)")

    serve = sub.add_parser("serve", help="run the HTTP service on 127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    common(serve)
    bench = sub.add_parser("bench", help="time the model and write sample WAVs")
    bench.add_argument("--reference", required=True, help="reference WAV (PCM 16-bit mono, at most 30 s)")
    bench.add_argument("--reference-text", required=True, help="the words spoken in the reference clip")
    bench.add_argument("--out", default="./bench")
    bench.add_argument("--design", default=None, metavar="INSTRUCT", help="also time one voice design from this description and save it")
    common(bench)
    return parser


def design_options(args: argparse.Namespace) -> dict:
    return {"design_device": resolve_design_device(args.design_device, args.device), "design_dtype": args.design_dtype, "design_model_dir": args.design_model_dir}
def main(argv: Optional[list] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    args = build_parser().parse_args(argv)
    token = os.environ.get(TOKEN_ENV)
    try:
        if args.command == "serve":
            config = Config(validate_token(token), args.port, args.dtype, args.attn, args.device, args.model_dir, **design_options(args))
            server = Server(config)
            server.start_loading()
            log.info("listening on http://127.0.0.1:%d (model loading in the background)", server.port)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            return 0
        config = Config(token or "", 0, args.dtype, args.attn, args.device, args.model_dir, **design_options(args))
        run_bench(config, args.reference, args.reference_text, args.out, design=args.design)
        return 0
    except ConfigError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
