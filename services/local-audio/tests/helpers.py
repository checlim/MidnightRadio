import base64
import hashlib
import http.client
import io
import json
import threading
import wave
from contextlib import contextmanager
from typing import Optional

from local_audio.backends import FakeBackend
from local_audio.backends.base import Backend
from local_audio.config import Config
from local_audio.server import LocalAudioServer
from local_audio.wav import encode_wav

TRANSCRIPT = "The night air is chill, and the hour is late."


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def reference_wav(k: int = 0, frames: int = 2400, rate: int = 24_000) -> bytes:
    """A small mono 16-bit reference clip; a different `k` gives different samples."""
    return encode_wav([(j * (k + 3)) % 2000 - 1000 for j in range(frames)], rate)


def tts_body(text: str = "Good evening, listeners.", k: int = 0, **overrides) -> dict:
    """A valid POST /tts body. `overrides` replace top-level fields."""
    body = {"text": text, "language": "English", "seed": 0, "reference": {"audio": base64.b64encode(reference_wav(k)).decode("ascii"), "text": TRANSCRIPT}}
    body.update(overrides)
    return body


class Running:
    def __init__(self, server: LocalAudioServer):
        self.server = server
        self.port = server.port

    def request(self, method: str, path: str, body=None, headers: Optional[dict] = None, raw: Optional[bytes] = None):
        """Returns (status, headers, body bytes)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        sent = {"Content-Type": "application/json"} if method == "POST" else {}
        sent.update(headers or {})
        payload = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
        conn.request(method, path, body=payload, headers=sent)
        res = conn.getresponse()
        data = res.read()
        out = (res.status, {k.lower(): v for k, v in res.getheaders()}, data)
        conn.close()
        return out

    def json(self, method: str, path: str, body=None, headers=None):
        status, hdrs, data = self.request(method, path, body, headers)
        return status, json.loads(data.decode("utf-8")) if data else None


@contextmanager
def serving(backend: Optional[Backend] = None, token: Optional[str] = None, queue_timeout_s: float = 30.0, max_text_chars: int = 4_000):
    config = Config(host="127.0.0.1", port=0, backend="fake", token=token, max_text_chars=max_text_chars, queue_timeout_s=queue_timeout_s)
    server = LocalAudioServer(config, backend or FakeBackend())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield Running(server)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def wav_info(data: bytes) -> dict:
    with wave.open(io.BytesIO(data)) as w:
        return {"rate": w.getframerate(), "channels": w.getnchannels(), "width": w.getsampwidth(), "frames": w.getnframes()}
