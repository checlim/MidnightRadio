"""HTTP API: GET /health, POST /tts, POST /sfx.

Hardening, because this is a model server on a developer's machine:
- bound to loopback by `config.py`; the Host header must name the loopback address and our port,
  which blocks DNS-rebinding pages; any request that carries an Origin header (a browser page) is refused;
- JSON requests only, with a small body limit and strict field checks;
- an optional bearer token, compared in constant time and never logged or echoed;
- one model call at a time, because one local model cannot serve two at once;
- logs hold the method, the path and the status only: never bodies, headers or tokens.
"""

import hmac
import json
import logging
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

from . import API_VERSION, SERVICE_NAME
from .backends import Backend, BackendError, SfxRequest, TtsRequest
from .catalogue import VoiceClip
from .config import Config

log = logging.getLogger("local_audio")

MAX_BODY_BYTES = 64 * 1024
DELIVERIES = frozenset({"neutral", "whisper", "urgent", "fearful", "sinister", "warm"})
_VOICE_ID = re.compile(r"^[\w.:-]{1,100}$")
MAX_SEED = 2**31 - 1


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_fields(body: dict, allowed: set) -> None:
    unknown = sorted(set(body) - allowed)
    if unknown:
        raise HttpError(400, "bad_request", f"unknown field '{unknown[0]}'")


def _seed(body: dict) -> Optional[int]:
    seed = body.get("seed")
    if seed is None:
        return None
    if not _is_int(seed) or not 0 <= seed <= MAX_SEED:
        raise HttpError(400, "bad_request", "seed must be an integer from 0 to 2147483647")
    return seed


class LocalAudioServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: Config, backend: Backend, clips: dict[str, VoiceClip]):
        super().__init__((config.host, config.port), _Handler)
        self.config = config
        self.backend = backend
        self.clips = clips
        self.model_lock = threading.Lock()

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
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

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

    def _read_json(self) -> dict:
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            raise HttpError(415, "unsupported_media_type", "send application/json")
        if self.headers.get("Transfer-Encoding") is not None:
            raise HttpError(411, "length_required", "send a Content-Length, not a chunked body")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isdigit():
            raise HttpError(411, "length_required", "send a Content-Length")
        length = int(raw_length)
        if length > MAX_BODY_BYTES:
            raise HttpError(413, "too_large", f"requests are limited to {MAX_BODY_BYTES // 1024} KB")
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
        routes = {"/health": "GET", "/tts": "POST", "/sfx": "POST"}
        if path not in routes:
            raise HttpError(404, "not_found", "no such endpoint")
        if routes[path] != method:
            raise HttpError(405, "method_not_allowed", f"use {routes[path]}")
        self._check_caller()
        if path == "/health":
            return self._health()
        body = self._read_json()
        return self._tts(body) if path == "/tts" else self._sfx(body)

    def _health(self) -> None:
        backend = self.server.backend
        self._json(
            200,
            {
                "service": SERVICE_NAME,
                "apiVersion": API_VERSION,
                "backend": backend.name,
                "tts": backend.tts_info(),
                "sfx": backend.sfx_info(),
                "voices": {vid: {"clipSha256": c.sha256, "transcriptSha256": c.transcript_sha256} for vid, c in sorted(self.server.clips.items())},
            },
        )

    def _tts(self, body: dict) -> None:
        _check_fields(body, {"voiceId", "text", "delivery", "seed"})
        voice_id = body.get("voiceId")
        if not isinstance(voice_id, str) or not _VOICE_ID.match(voice_id):
            raise HttpError(400, "bad_request", "voiceId is missing or invalid")
        text = body.get("text")
        limit = self.server.config.max_text_chars
        if not isinstance(text, str) or not text.strip():
            raise HttpError(400, "bad_request", "text must not be blank")
        if len(text) > limit:
            raise HttpError(400, "bad_request", f"text is limited to {limit} characters")
        delivery = body.get("delivery")
        if delivery is not None and delivery not in DELIVERIES:
            raise HttpError(400, "bad_request", "unknown delivery")
        clip = self.server.clips.get(voice_id)
        if clip is None:
            raise HttpError(404, "unknown_voice", "no such voice in the catalogue")
        if self.server.backend.tts_info() is None:
            raise HttpError(503, "not_ready", "this backend has no speech model")
        request = TtsRequest(voice_id, clip, text, delivery, _seed(body))
        self._render(lambda: self.server.backend.render_tts(request), "tts")

    def _sfx(self, body: dict) -> None:
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
        self._render(lambda: self.server.backend.render_sfx(request), "sfx")

    def _render(self, call: Any, kind: str) -> None:
        if not self.server.model_lock.acquire(timeout=self.server.config.queue_timeout_s):
            raise HttpError(503, "busy", "the model is busy; try again")
        started = time.monotonic()
        try:
            wav = call()
        finally:
            self.server.model_lock.release()
        info = (self.server.backend.tts_info() if kind == "tts" else self.server.backend.sfx_info()) or {}
        self._send(200, wav, "audio/wav", {"X-Model-Revision": str(info.get("revision", "")), "X-Render-Ms": str(round((time.monotonic() - started) * 1000))})

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
