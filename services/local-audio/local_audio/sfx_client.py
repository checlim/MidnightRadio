"""Client for the sound-effect service API, version 1 (docs/sfx-service-api.md).

Used only by the offline foley tool (tools/generate_sfx.py); standard library only. Everything
the server sends is untrusted: `/health` is checked field by field, every WAV is parsed in full,
and the token is never sent over plain http to anything but loopback, never sent after a
redirect, and masked in every message.
"""
import array
import http.client
import json
import re
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Mapping, Optional

API_VERSION = 1
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
MAX_WAV_BYTES = 20 * 1024 * 1024
MAX_JSON_BYTES = 256 * 1024
DURATION_TOLERANCE_S = 0.05
MIN_TOKEN = 16
DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
MAX_SEED = 2_147_483_647
BUSY_RETRIES = 10
BUSY_MAX_WAIT_S = 60.0
_SHA = re.compile(r"^[0-9a-f]{64}$")


class SfxClientError(Exception):
    """A take failed in a way that may succeed on retry (server error, timeout, unusable audio)."""


class SfxFatalError(Exception):
    """Stop the whole run: bad configuration, wrong token, not a conforming server, or the model changed."""


@dataclass(frozen=True)
class ClientConfig:
    base_url: str
    token: Optional[str]
    timeout_s: float


@dataclass(frozen=True)
class ModelInfo:
    model: str
    revision: str
    weights_sha256: Optional[str]
    license: str
    sample_rate: int

    def identity(self) -> dict:
        """What must not change within one run (and is recorded with every take)."""
        return {"model": self.model, "revision": self.revision, "weightsSha256": self.weights_sha256, "license": self.license, "sampleRate": self.sample_rate}


@dataclass(frozen=True)
class WavInfo:
    sample_rate: int
    frames: int
    peak: int

    @property
    def duration_s(self) -> float:
        return self.frames / self.sample_rate


def load_config(env: Mapping[str, str]) -> ClientConfig:
    """Read SFX_SERVICE_URL, SFX_SERVICE_TOKEN and SFX_SERVICE_TIMEOUT_MS. Raises SfxFatalError."""
    raw = (env.get("SFX_SERVICE_URL") or "").strip()
    if not raw:
        raise SfxFatalError("set SFX_SERVICE_URL to the sound-effect server, e.g. http://127.0.0.1:8765")
    token = (env.get("SFX_SERVICE_TOKEN") or "").strip() or None
    if token is not None and (len(token) < MIN_TOKEN or any(c.isspace() for c in token)):
        raise SfxFatalError(f"SFX_SERVICE_TOKEN must be at least {MIN_TOKEN} characters with no spaces")
    timeout_raw = (env.get("SFX_SERVICE_TIMEOUT_MS") or "").strip()
    if timeout_raw and not timeout_raw.isdigit():
        raise SfxFatalError("SFX_SERVICE_TIMEOUT_MS must be a whole number of milliseconds")
    timeout_ms = int(timeout_raw) if timeout_raw else DEFAULT_TIMEOUT_MS
    if not 1_000 <= timeout_ms <= 60 * 60 * 1000:
        raise SfxFatalError("SFX_SERVICE_TIMEOUT_MS must be between 1000 and 3600000")
    return ClientConfig(check_url(raw, token), token, timeout_ms / 1000)


def check_url(raw: str, token: Optional[str]) -> str:
    """Plain http only on loopback; anything else needs https and a token. Returns the URL without a trailing slash."""
    try:
        url = urllib.parse.urlsplit(raw)
        url.port  # noqa: B018  (raises on a malformed port)
    except ValueError:
        raise SfxFatalError("SFX_SERVICE_URL is not a valid URL") from None
    if url.scheme not in ("http", "https") or not url.hostname:
        raise SfxFatalError("SFX_SERVICE_URL must be an http or https URL")
    if url.username or url.password:
        raise SfxFatalError("SFX_SERVICE_URL must not contain credentials; use SFX_SERVICE_TOKEN")
    if url.query or url.fragment:
        raise SfxFatalError("SFX_SERVICE_URL must not have a query or fragment")
    loopback = url.hostname.lower() in LOOPBACK
    if not loopback and url.scheme != "https":
        raise SfxFatalError("a sound-effect server that is not on this machine must use https")
    if not loopback and token is None:
        raise SfxFatalError("a sound-effect server that is not on this machine needs SFX_SERVICE_TOKEN")
    return raw.rstrip("/")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        raise SfxFatalError(f"the server answered with a redirect ({code}); redirects are not followed, so the token stays with the host you named")


def parse_wav(data: bytes) -> WavInfo:
    """Strictly parse a complete mono 16-bit PCM WAV. Raises SfxClientError."""
    if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise SfxClientError("the answer is not a WAV file")
    if struct.unpack_from("<I", data, 4)[0] != len(data) - 8:
        raise SfxClientError("the WAV size field does not match the file (truncated, padded or streamed)")
    pos, fmt, pcm = 12, None, None
    while pos + 8 <= len(data):
        tag, size = data[pos:pos + 4], struct.unpack_from("<I", data, pos + 4)[0]
        body_end = pos + 8 + size
        if body_end > len(data):
            raise SfxClientError("a WAV chunk runs past the end of the file")
        if tag == b"fmt ":
            if size < 16:
                raise SfxClientError("the WAV format chunk is too short")
            fmt = struct.unpack_from("<HHIIHH", data, pos + 8)
        elif tag == b"data":
            pcm = (pos + 8, size)
        pos = body_end + (size & 1)
    if pos != len(data):
        raise SfxClientError("the WAV has trailing bytes after its last chunk")
    if fmt is None or pcm is None:
        raise SfxClientError("the WAV has no format or data chunk")
    audio_format, channels, rate, byte_rate, block, bits = fmt
    if audio_format != 1 or channels != 1 or bits != 16 or block != 2 or byte_rate != rate * 2:
        raise SfxClientError("the WAV must be PCM, mono, 16-bit")
    start, size = pcm
    if size == 0 or size % 2:
        raise SfxClientError("the WAV has no audio or a partial sample")
    samples = array.array("h", data[start:start + size])
    if sys.byteorder == "big":
        samples.byteswap()
    peak = max(max(samples), -min(samples))
    if peak == 0:
        raise SfxClientError("the WAV is silent")
    return WavInfo(rate, size // 2, peak)


class SfxClient:
    def __init__(self, config: ClientConfig, sleep: Callable[[float], None] = time.sleep):
        self.config = config
        self._sleep = sleep
        handlers = [_NoRedirect(), urllib.request.ProxyHandler({})]
        if config.base_url.startswith("https:"):
            handlers.append(urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        self._opener = urllib.request.build_opener(*handlers)

    # --- low level ---------------------------------------------------------------------------
    def _mask(self, text: str) -> str:
        token = self.config.token
        return text.replace(token, "[token]") if token else text

    def _call(self, method: str, path: str, body: Optional[dict], limit: int):
        headers = {"Accept": "application/json, audio/wav"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.config.token:
            headers["Authorization"] = f"Bearer {self.config.token}"
        req = urllib.request.Request(self.config.base_url + path, data=data, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=self.config.timeout_s) as resp:
                return resp.status, resp.headers, _read_capped(resp, limit)
        except urllib.error.HTTPError as err:
            return err.code, err.headers, _read_capped(err, MAX_JSON_BYTES)
        except SfxFatalError:
            raise
        except (urllib.error.URLError, http.client.HTTPException, socket.timeout, TimeoutError, ConnectionError, OSError) as err:
            reason = getattr(err, "reason", err)
            raise SfxClientError(self._mask(f"could not reach the server: {type(reason).__name__}")) from None

    def _error_text(self, status: int, payload: bytes) -> str:
        try:
            error = json.loads(payload.decode("utf-8"))["error"]
            text = f"{error.get('code', '?')}: {str(error.get('message', ''))[:300]}"
        except (ValueError, KeyError, TypeError, AttributeError):
            text = "no error details"
        return self._mask(f"HTTP {status} ({text})")

    def _with_busy_retries(self, method: str, path: str, body: Optional[dict], limit: int):
        """Answer 503 busy/not_ready by waiting (exponential back-off, capped) and asking again."""
        wait = 2.0
        for attempt in range(BUSY_RETRIES + 1):
            status, headers, payload = self._call(method, path, body, limit)
            if status != 503 or attempt == BUSY_RETRIES:
                return status, headers, payload
            self._sleep(wait)
            wait = min(wait * 2, BUSY_MAX_WAIT_S)
        raise AssertionError("unreachable")

    def _check_status(self, status: int, payload: bytes) -> None:
        if status == 200:
            return
        message = self._error_text(status, payload)
        if status in (400, 401, 403, 404, 405, 411, 413, 415):
            hint = {401: " Check SFX_SERVICE_TOKEN.", 403: " The server refused this client.", 404: " Is this a sound-effect server?", 405: " Is this a sound-effect server?"}.get(status, "")
            raise SfxFatalError(f"the server refused the request: {message}.{hint}")
        raise SfxClientError(f"the server failed: {message}")

    # --- API ---------------------------------------------------------------------------------
    def health(self) -> ModelInfo:
        """GET /health, checked. Waits while the model is loading. Raises SfxFatalError if it is not usable."""
        for _ in range(BUSY_RETRIES + 1):
            status, _headers, payload = self._with_busy_retries("GET", "/health", None, MAX_JSON_BYTES)
            self._check_status(status, payload)
            info = parse_health(payload)
            if info is not None:
                return info
            self._sleep(BUSY_MAX_WAIT_S / 4)
        raise SfxFatalError("the sound-effect model did not become ready")

    def render(self, prompt: str, duration_s: float, seed: int, expected: ModelInfo) -> tuple:
        """POST /sfx once (busy answers are waited out). Returns (wav bytes, WavInfo, render ms or None).

        Raises SfxClientError for a failed or unusable take, SfxFatalError to stop the run.
        """
        if not prompt.strip() or len(prompt) > 500:
            raise SfxFatalError("prompts must be 1 to 500 characters")
        if isinstance(duration_s, bool) or not 0.5 <= float(duration_s) <= 30:
            raise SfxFatalError("durations must be between 0.5 and 30 seconds")
        if not 0 <= seed <= MAX_SEED:
            raise SfxFatalError(f"seeds must be between 0 and {MAX_SEED}")
        status, headers, payload = self._with_busy_retries("POST", "/sfx", {"prompt": prompt, "durationSec": duration_s, "seed": seed}, MAX_WAV_BYTES)
        self._check_status(status, payload)
        revision = headers.get("X-Model-Revision")
        if revision != expected.revision:
            # Ask again: if the model really changed, stop rather than mix takes from two models.
            now = self.health()
            if now.identity() != expected.identity():
                raise SfxFatalError(f"the server's model changed during the run ({expected.model}@{expected.revision[:12]} → {now.model}@{now.revision[:12]}); use a new output folder for a different model")
            raise SfxClientError("the audio did not say which model revision made it (X-Model-Revision)")
        content_type = (headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type not in ("audio/wav", "audio/x-wav", "audio/wave"):
            raise SfxClientError(f"the answer is {content_type or 'untyped'}, not audio/wav")
        info = parse_wav(payload)
        if info.sample_rate != expected.sample_rate:
            raise SfxClientError(f"the WAV is {info.sample_rate} Hz, but /health reported {expected.sample_rate} Hz")
        if abs(info.duration_s - float(duration_s)) > DURATION_TOLERANCE_S:
            raise SfxClientError(f"the WAV is {info.duration_s:.3f} s long, not {float(duration_s):.1f} s")
        render_ms = headers.get("X-Render-Ms")
        return payload, info, int(render_ms) if render_ms and render_ms.isdigit() else None


def _read_capped(resp, limit: int) -> bytes:
    data = resp.read(limit + 1)
    if len(data) > limit:
        raise SfxClientError(f"the answer is larger than {limit // (1024 * 1024) or 1} MB")
    return data


def _text(value, lo: int = 1, hi: int = 100) -> Optional[str]:
    return value if isinstance(value, str) and lo <= len(value.strip()) and len(value) <= hi else None


def parse_health(payload: bytes) -> Optional[ModelInfo]:
    """The model info from a /health answer, None while it is not ready. Raises SfxFatalError if non-conforming."""
    try:
        body = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise SfxFatalError("/health did not answer JSON; is this a sound-effect server?") from None
    if not isinstance(body, dict) or body.get("apiVersion") != API_VERSION or isinstance(body.get("apiVersion"), bool):
        raise SfxFatalError(f"the server does not speak sound-effect API version {API_VERSION}")
    sfx = body.get("sfx")
    if sfx is None:
        raise SfxFatalError("the server has no sound-effect model (/health reports sfx: null)")
    if not isinstance(sfx, dict):
        raise SfxFatalError("/health has an invalid sfx entry")
    model, revision, license_ = _text(sfx.get("model")), _text(sfx.get("revision")), _text(sfx.get("license"))
    weights = sfx.get("weightsSha256")
    rate = sfx.get("sampleRate")
    problems = [
        name
        for name, ok in [
            ("model", model is not None),
            ("revision", revision is not None),
            ("license", license_ is not None),
            ("weightsSha256", weights is None or (isinstance(weights, str) and _SHA.match(weights) is not None)),
            ("sampleRate", isinstance(rate, int) and not isinstance(rate, bool) and 24_000 <= rate <= 96_000),
            ("ready", isinstance(sfx.get("ready"), bool)),
        ]
        if not ok
    ]
    if problems:
        raise SfxFatalError(f"/health has missing or invalid sfx fields: {', '.join(problems)}")
    if not sfx["ready"]:
        return None
    return ModelInfo(model, revision, weights, license_, rate)
