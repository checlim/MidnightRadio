import hashlib
import http.client
import io
import json
import tempfile
import threading
import wave
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from local_audio.backends import FakeBackend
from local_audio.backends.base import Backend
from local_audio.catalogue import load_catalogue
from local_audio.config import Config
from local_audio.server import LocalAudioServer
from local_audio.wav import encode_wav

TRANSCRIPT = "The night air is chill, and the hour is late."
VOICES = ("stub-f1", "stub-m1", "stub-n1")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_catalogue(directory: Path, voices=VOICES, mutate=None) -> Path:
    """A catalogue.json with one small clip per voice. `mutate(entries)` may break it on purpose."""
    (directory / "clips").mkdir(exist_ok=True)
    entries = []
    for i, voice_id in enumerate(voices):
        clip = encode_wav([(j * (i + 3)) % 2000 - 1000 for j in range(2400)], 24_000)
        (directory / "clips" / f"{voice_id}.wav").write_bytes(clip)
        entries.append({"id": voice_id, "clip": {"file": f"clips/{voice_id}.wav", "sha256": sha256(clip), "transcript": TRANSCRIPT}})
    if mutate:
        mutate(entries)
    path = directory / "catalogue.json"
    path.write_text(json.dumps({"voices": entries}), encoding="utf-8")
    return path


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
def serving(backend: Optional[Backend] = None, token: Optional[str] = None, queue_timeout_s: float = 30.0, max_text_chars: int = 4_000, mutate=None):
    with tempfile.TemporaryDirectory() as tmp:
        catalogue = write_catalogue(Path(tmp), mutate=mutate)
        config = Config(host="127.0.0.1", port=0, catalogue_path=catalogue, backend="fake", token=token, max_text_chars=max_text_chars, queue_timeout_s=queue_timeout_s)
        server = LocalAudioServer(config, backend or FakeBackend(), load_catalogue(catalogue))
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
