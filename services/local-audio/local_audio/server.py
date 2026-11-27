"""HTTP API: GET /health, POST /tts, POST /voice-design, POST /sfx. /tts and /voice-design implements docs/tts-service-api.md.

Hardening, because this is a model server on a developer's machine:
- bound to loopback by `config.py`; the Host header must name the loopback address and our port,
  which blocks DNS-rebinding pages; any request that carries an Origin header (a browser page) is refused;
- JSON requests only, with a body limit (4 MB for /tts, whose reference clip is inside; 64 KB for /sfx) and strict field checks;
- an optional bearer token, compared in constant time and never logged or echoed;
- one model call at a time, because one local model cannot serve two at once;
- /sfx honours an optional Idempotency-Key (docs/sfx-service-api.md); the key is never logged;
- logs hold the method, the path and the status only: never bodies, headers or tokens.
"""

import base64
import binascii
import collections
import hashlib
import hmac
import io
import json
import logging
import re
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

from . import API_VERSION, SERVICE_NAME
from .backends import Backend, BackendError, SfxRequest, TtsRequest, VoiceDesignRequest
from .config import Config

log = logging.getLogger("local_audio")

MAX_BODY_BYTES = 64 * 1024
MAX_TTS_BODY_BYTES = 4 * 1024 * 1024
MAX_LANGUAGE_CHARS = 40
MAX_REFERENCE_TEXT_CHARS = 500
MAX_DESIGN_CHARS = 500
MAX_REFERENCE_SECONDS = 30
MIN_REFERENCE_RATE, MAX_REFERENCE_RATE = 8_000, 48_000
MAX_SEED = 2**31 - 1
MAX_IDEMPOTENT_RESULTS = 32
IDEMPOTENCY_RETRY_AFTER_S = 5
_IDEMPOTENCY_KEY = re.compile(r"[0-9a-f]{64}")


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_fields(body: dict, allowed: set) -> None:
    if set(body) - allowed:  # the name is not echoed: it comes from the request
        raise HttpError(400, "bad_request", "the request has a field this API does not define")


def _seed(body: dict) -> Optional[int]:
    seed = body.get("seed")
    if seed is None:
        return None
    if not _is_int(seed) or not 0 <= seed <= MAX_SEED:
        raise HttpError(400, "bad_request", "seed must be an integer from 0 to 2147483647")
    return seed


def _reference_wav(value: Any) -> bytes:
    """Decode and check the reference clip. Messages never contain the data."""
    bad = HttpError(400, "bad_request", "reference.audio must be base64 of a PCM 16-bit mono WAV file of at most 30 seconds")
    if not isinstance(value, str) or not value:
        raise bad
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise bad from None
    try:
        with wave.open(io.BytesIO(data)) as w:
            channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            if channels != 1 or width != 2 or not MIN_REFERENCE_RATE <= rate <= MAX_REFERENCE_RATE:
                raise bad
            if not 1 <= frames <= MAX_REFERENCE_SECONDS * rate:
                raise bad
            if len(w.readframes(frames)) != frames * 2:  # the header promises more than the file holds
                raise bad
    except (wave.Error, EOFError):
        raise bad from None
    return data


class IdempotencyTable:
    """Remembers /sfx requests by Idempotency-Key. Own lock; never held while rendering.

    Finished results are kept until restart, at most `max_results` of them (oldest evicted first).
    A key that is rendering is never evicted.
    """
    def __init__(self, max_results: int = MAX_IDEMPOTENT_RESULTS):
        self.max_results = max_results
        self._lock = threading.Lock()
        self._running: dict = {}  # key -> fingerprint
        self._done: "collections.OrderedDict[str, tuple]" = collections.OrderedDict()  # key -> (fingerprint, wav, headers)
    def begin(self, key: str, fingerprint: str) -> Optional[tuple]:
        """Returns (wav, headers) to replay, or None when the caller must render (the key is then reserved)."""
        with self._lock:
            if key in self._running:
                raise HttpError(409, "in_progress", "a request with this Idempotency-Key is still rendering; retry with the same key")
            if key in self._done:
                stored, wav, headers = self._done[key]
                if stored != fingerprint:
                    raise HttpError(422, "idempotency_mismatch", "this Idempotency-Key was used with a different request")
                return wav, dict(headers)
            self._running[key] = fingerprint
            return None
    def finish(self, key: str, fingerprint: str, wav: bytes, headers: dict) -> None:
        with self._lock:
            self._running.pop(key, None)
            self._done[key] = (fingerprint, wav, dict(headers))
            while len(self._done) > self.max_results:
                self._done.popitem(last=False)
    def forget(self, key: str) -> None:
        with self._lock:
            self._running.pop(key, None)
class LocalAudioServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: Config, backend: Backend):
        super().__init__((config.host, config.port), _Handler)
        self.config = config
        self.backend = backend
        self.model_lock = threading.Lock()
        self.idempotency = IdempotencyTable()

    @property
    def port(self) -> int:
        return self.server_address[1]


class _Handler(BaseHTTPRequestHandler):
    server: LocalAudioServer
    server_version = SERVICE_NAME
    sys_version = ""

    # Our own access log (below) replaces the default, which prints the client address.
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
        extra = {"Retry-After": str(IDEMPOTENCY_RETRY_AFTER_S)} if status == 409 else None
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json", extra)

    def _error(self, err: HttpError) -> None:
        self._json(err.status, {"error": {"code": err.code, "message": err.message}})

    # --- request checks -------------------------------------------------------------------------

    def _check_caller(self) -> None:
        allowed = {f"127.0.0.1:{self.server.port}", f"localhost:{self.server.port}"}
        if self.headers.get("Host") not in allowed:
            raise HttpError(403, "bad_host", "this service answers only on its loopback address")
        if self.headers.get("Origin") is not None:
            raise HttpError(403, "bad_origin", "browser requests are not accepted")
        token = self.server.config.token
        if token is not None:
            header = self.headers.get("Authorization") or ""
            supplied = header[7:] if header[:7].lower() == "bearer " else ""
            if not hmac.compare_digest(supplied.encode("utf-8"), token.encode("utf-8")):
                raise HttpError(401, "unauthorized", "a valid access token is required")

    def _read_json(self, max_bytes: int) -> dict:
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            raise HttpError(415, "unsupported_media_type", "send application/json")
        if self.headers.get("Transfer-Encoding") is not None:
            raise HttpError(411, "length_required", "send a Content-Length, not a chunked body")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isdigit():
            raise HttpError(411, "length_required", "send a Content-Length")
        length = int(raw_length)
        if length > max_bytes:
            raise HttpError(413, "too_large", f"requests are limited to {max_bytes // 1024} KB")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise HttpError(400, "bad_request", "the body is not valid JSON") from None
        if not isinstance(body, dict):
            raise HttpError(400, "bad_request", "the body must be a JSON object")
        return body

    # --- routes ---------------------------------------------------------------------------------

    def _route(self, method: str) -> None:
        path = self.path.split("?", 1)[0]
        routes = {"/health": "GET", "/tts": "POST", "/voice-design": "POST", "/sfx": "POST"}
        if path not in routes:
            raise HttpError(404, "not_found", "no such endpoint")
        if routes[path] != method:
            raise HttpError(405, "method_not_allowed", f"use {routes[path]}")
        self._check_caller()
        if path == "/health":
            return self._health()
        body = self._read_json(MAX_TTS_BODY_BYTES if path == "/tts" else MAX_BODY_BYTES)
        if path == "/tts":
            return self._tts(body)
        return self._design(body) if path == "/voice-design" else self._sfx(body)

    def _health(self) -> None:
        backend = self.server.backend
        sfx = backend.sfx_info()
        if sfx is not None:
            sfx = {**sfx, "idempotency": True}
        self._json(
            200,
            {
                "service": SERVICE_NAME,
                "apiVersion": API_VERSION,
                "backend": backend.name,
                "tts": backend.tts_info(),
                "sfx": sfx,
                "voiceDesign": backend.design_info(),
            },
        )

    def _tts(self, body: dict) -> None:
        _check_fields(body, {"text", "language", "seed", "reference"})
        text = body.get("text")
        limit = self.server.config.max_text_chars
        if not isinstance(text, str) or not text.strip():
            raise HttpError(400, "bad_request", "text must not be blank")
        if len(text) > limit:
            raise HttpError(400, "bad_request", f"text is limited to {limit} characters")
        language = body.get("language")
        if not isinstance(language, str) or not language.strip() or len(language) > MAX_LANGUAGE_CHARS:
            raise HttpError(400, "bad_request", f"language must be 1 to {MAX_LANGUAGE_CHARS} characters")
        if body.get("seed") is None:
            raise HttpError(400, "bad_request", "seed is required")
        seed = _seed(body)
        reference = body.get("reference")
        if not isinstance(reference, dict):
            raise HttpError(400, "bad_request", "reference must be an object with audio and text")
        _check_fields(reference, {"audio", "text"})
        reference_text = reference.get("text")
        if not isinstance(reference_text, str) or not reference_text.strip() or len(reference_text) > MAX_REFERENCE_TEXT_CHARS:
            raise HttpError(400, "bad_request", f"reference.text must be 1 to {MAX_REFERENCE_TEXT_CHARS} characters")
        reference_wav = _reference_wav(reference.get("audio"))
        if self.server.backend.tts_info() is None:
            raise HttpError(503, "not_ready", "this backend has no speech model")
        request = TtsRequest(text, language, reference_wav, reference_text, seed)
        self._render(lambda: self.server.backend.render_tts(request), "tts")

    def _design(self, body: dict) -> None:
        _check_fields(body, {"instruct", "text", "language", "seed"})
        for field in ("instruct", "text"):
            value = body.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > MAX_DESIGN_CHARS:
                raise HttpError(400, "bad_request", f"{field} must be 1 to {MAX_DESIGN_CHARS} characters")
        language = body.get("language")
        if not isinstance(language, str) or not language.strip() or len(language) > MAX_LANGUAGE_CHARS:
            raise HttpError(400, "bad_request", f"language must be 1 to {MAX_LANGUAGE_CHARS} characters")
        if body.get("seed") is None:
            raise HttpError(400, "bad_request", "seed is required")
        seed = _seed(body)
        if self.server.backend.design_info() is None:
            raise HttpError(503, "not_ready", "this backend has no voice-design model")
        request = VoiceDesignRequest(body["instruct"], body["text"], language, seed)
        self._render(lambda: self.server.backend.render_design(request), "design")

    def _idempotency_key(self) -> Optional[str]:
        values = self.headers.get_all("Idempotency-Key")
        if values is None:
            return None
        if len(values) != 1 or not _IDEMPOTENCY_KEY.fullmatch(values[0]):
            raise HttpError(400, "bad_request", "Idempotency-Key must be 64 lowercase hex characters")
        return values[0]
    def _sfx(self, body: dict) -> None:
        key = self._idempotency_key()
        _check_fields(body, {"prompt", "durationSec", "seed"})
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 500:
            raise HttpError(400, "bad_request", "prompt must be 1 to 500 characters")
        duration = body.get("durationSec")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not 0.5 <= duration <= 30:
            raise HttpError(400, "bad_request", "durationSec must be between 0.5 and 30")
        if self.server.backend.sfx_info() is None:
            raise HttpError(503, "not_ready", "this backend has no sound-effect model")
        request = SfxRequest(prompt, float(duration), _seed(body))
        def call() -> bytes:
            return self.server.backend.render_sfx(request)
        if key is None:
            return self._render(call, "sfx")
        canonical = json.dumps({"prompt": prompt, "durationSec": float(duration), "seed": request.seed}, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        fingerprint = hashlib.sha256(canonical.encode("ascii")).hexdigest()
        replay = self.server.idempotency.begin(key, fingerprint)
        if replay is not None:
            wav, headers = replay
            headers["X-Idempotent-Replay"] = "true"
            return self._send(200, wav, "audio/wav", headers)
        try:
            wav, headers = self._render_result(call, "sfx")
        except BaseException:
            self.server.idempotency.forget(key)
            raise
        self.server.idempotency.finish(key, fingerprint, wav, headers)
        self._send(200, wav, "audio/wav", headers)

    def _render(self, call: Any, kind: str) -> None:
        wav, headers = self._render_result(call, kind)
        self._send(200, wav, "audio/wav", headers)

    def _render_result(self, call: Any, kind: str) -> tuple:
        if not self.server.model_lock.acquire(timeout=self.server.config.queue_timeout_s):
            raise HttpError(503, "busy", "the model is busy; try again")
        started = time.monotonic()
        try:
            wav = call()
        finally:
            self.server.model_lock.release()
        backend = self.server.backend
        info = {"tts": backend.tts_info, "design": backend.design_info, "sfx": backend.sfx_info}[kind]() or {}
        return wav, {"X-Model-Revision": str(info.get("revision", "")), "X-Render-Ms": str(round((time.monotonic() - started) * 1000))}

    # --- entry points ---------------------------------------------------------------------------

    def _handle(self, method: str) -> None:
        try:
            self._route(method)
        except HttpError as err:
            self._error(err)
        except BackendError as err:
            self._error(HttpError(err.status, err.code, err.message))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as err:  # noqa: BLE001 - never leak details or the request to the client
            log.error("%s %s failed: %s", self.command, self.path.split("?", 1)[0], type(err).__name__)
            self._error(HttpError(500, "internal", "the service failed to handle the request"))

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    do_DELETE = do_PATCH = do_PUT  # noqa: N815
