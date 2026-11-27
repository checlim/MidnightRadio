import base64
import io
import json
import socket
import threading
import time
import unittest
import wave

from local_audio import API_VERSION, SERVICE_NAME
from local_audio.backends import BackendError, FakeBackend, VoiceDesignRequest
from local_audio.server import MAX_TTS_BODY_BYTES
from tests.helpers import TRANSCRIPT, reference_wav, serving, tts_body, wav_info

TOKEN = "a-long-local-token-1234"


class Counting(FakeBackend):
    """Records how many model calls overlap."""

    def __init__(self, delay_ms: int = 0):
        super().__init__(delay_ms)
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()

    def render_tts(self, request):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            return super().render_tts(request)
        finally:
            with self.lock:
                self.active -= 1


class Failing(FakeBackend):
    def __init__(self, error: Exception):
        super().__init__()
        self.error = error

    def render_tts(self, request):
        raise self.error


class HealthTests(unittest.TestCase):
    def test_reports_the_service_and_its_models_and_no_voices(self):
        with serving() as s:
            status, body = s.json("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual((body["service"], body["apiVersion"], body["backend"]), (SERVICE_NAME, API_VERSION, "fake"))
        self.assertEqual(body["tts"], {"model": "fake-tts", "revision": "fake-1", "sampleRate": 24000, "ready": True})
        self.assertEqual(body["sfx"]["model"], "fake-sfx")
        self.assertNotIn("voices", body)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def pcm_wav(channels=1, width=2, rate=24_000, frames=2400) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(b"\x01" * (frames * channels * width))
    return buf.getvalue()


def with_reference(**fields) -> dict:
    body = tts_body()
    body["reference"].update(fields)
    return body


class TtsTests(unittest.TestCase):
    def test_returns_a_complete_24khz_mono_16bit_wav(self):
        with serving() as s:
            status, headers, data = s.request("POST", "/tts", tts_body())
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "audio/wav")
        self.assertEqual(headers["x-model-revision"], "fake-1")
        self.assertIn("x-render-ms", headers)
        self.assertEqual(headers["cache-control"], "no-store")
        info = wav_info(data)
        self.assertEqual((info["rate"], info["channels"], info["width"]), (24000, 1, 2))
        self.assertEqual(info["frames"], 3 * 350 * 24)  # three words

    def test_references_and_text_change_the_audio_and_identical_requests_match(self):
        with serving() as s:
            a = s.request("POST", "/tts", tts_body("Hello there.", k=0))[2]
            b = s.request("POST", "/tts", tts_body("Hello there.", k=1))[2]
            c = s.request("POST", "/tts", tts_body("Hello there, friend."))[2]
            again = s.request("POST", "/tts", tts_body("Hello there.", k=0))[2]
            other_text = s.request("POST", "/tts", with_reference(text="Another transcript."))[2]
        self.assertNotEqual(a, b)
        self.assertGreater(wav_info(c)["frames"], wav_info(a)["frames"])
        self.assertEqual(a, again)
        self.assertNotEqual(a, other_text)

    def test_the_backend_receives_the_request_fields(self):
        seen = []

        class Recording(FakeBackend):
            def render_tts(self, request):
                seen.append(request)
                return super().render_tts(request)

        with serving(backend=Recording()) as s:
            s.request("POST", "/tts", tts_body("Hush.", k=2, seed=7, language="French"))
        (request,) = seen
        self.assertEqual((request.text, request.language, request.seed, request.reference_text), ("Hush.", "French", 7, TRANSCRIPT))
        self.assertEqual(request.reference_wav, reference_wav(2))

    def test_rejects_bad_requests_with_a_json_error(self):
        def without(key):
            body = tts_body()
            del body[key]
            return body

        def nested(**fields):
            return with_reference(**fields)

        ok = b64(reference_wav())
        cases = {
            "no text": without("text"),
            "blank text": tts_body("   "),
            "text not a string": tts_body(text=5),
            "text too long": tts_body("x" * 4001),
            "no language": without("language"),
            "blank language": tts_body(language=" "),
            "language too long": tts_body(language="x" * 41),
            "language not a string": tts_body(language=3),
            "no seed": without("seed"),
            "null seed": tts_body(seed=None),
            "negative seed": tts_body(seed=-1),
            "bool seed": tts_body(seed=True),
            "float seed": tts_body(seed=1.5),
            "seed too big": tts_body(seed=2**31),
            "no reference": without("reference"),
            "reference not an object": tts_body(reference="abc"),
            "unknown top-level field": tts_body(delivery="whisper"),
            "old voiceId field": tts_body(voiceId="stub-f1"),
            "unknown nested field": nested(extra=1),
            "no reference audio": {**tts_body(), "reference": {"text": TRANSCRIPT}},
            "no reference text": {**tts_body(), "reference": {"audio": ok}},
            "blank reference text": nested(text="  "),
            "reference text too long": nested(text="x" * 501),
            "reference text not a string": nested(text=4),
            "empty audio": nested(audio=""),
            "audio not a string": nested(audio=12),
            "invalid base64 characters": nested(audio="not base64 !!!"),
            "bad base64 padding": nested(audio=ok[:-1]),
            "base64 with whitespace": nested(audio=ok[:8] + "\n" + ok[8:]),
            "not a wav": nested(audio=b64(b"definitely not a wav file")),
            "stereo": nested(audio=b64(pcm_wav(channels=2))),
            "8-bit": nested(audio=b64(pcm_wav(width=1))),
            "24-bit": nested(audio=b64(pcm_wav(width=3))),
            "rate too low": nested(audio=b64(pcm_wav(rate=7999))),
            "rate too high": nested(audio=b64(pcm_wav(rate=48_001))),
            "no frames": nested(audio=b64(pcm_wav(frames=0))),
            "over 30 seconds": nested(audio=b64(pcm_wav(rate=8000, frames=30 * 8000 + 1))),
            "truncated data": nested(audio=b64(reference_wav()[:-1000])),
        }
        with serving() as s:
            for name, body in cases.items():
                with self.subTest(case=name):
                    got, payload = s.json("POST", "/tts", body)
                    self.assertEqual((got, payload["error"]["code"]), (400, "bad_request"))
                    self.assertIsInstance(payload["error"]["message"], str)

    def test_reference_limits_are_inclusive(self):
        with serving() as s:
            for name, wav in {"one frame": pcm_wav(frames=1), "8 kHz": pcm_wav(rate=8000), "48 kHz": pcm_wav(rate=48_000), "exactly 30 s": pcm_wav(rate=8000, frames=30 * 8000)}.items():
                with self.subTest(case=name):
                    self.assertEqual(s.request("POST", "/tts", with_reference(audio=b64(wav)))[0], 200)
            self.assertEqual(s.request("POST", "/tts", tts_body(seed=0))[0], 200)
            self.assertEqual(s.request("POST", "/tts", tts_body(seed=2**31 - 1))[0], 200)
            self.assertEqual(s.request("POST", "/tts", tts_body(language="x" * 40))[0], 200)

    def test_text_at_the_limit_is_accepted_and_the_limit_is_configurable(self):
        with serving(max_text_chars=10) as s:
            self.assertEqual(s.request("POST", "/tts", tts_body("x" * 10))[0], 200)
            self.assertEqual(s.request("POST", "/tts", tts_body("x" * 11))[0], 400)

    def test_errors_and_logs_never_contain_the_text_or_the_reference(self):
        text = "A very private line of dialogue."
        ref_text = "A private reference transcript."
        audio = b64(pcm_wav(channels=2))
        bad_bodies = [
            {**tts_body(text), "reference": {"audio": audio, "text": ref_text}},
            {**tts_body(text), "reference": {"audio": "%%" + audio, "text": ref_text}},
            {**tts_body(text), "reference": {"audio": audio, "text": ref_text, "secret_field": 1}},
            {**tts_body(text), "seed": -1, "reference": {"audio": audio, "text": ref_text}},
            {**tts_body(text), "language": "x" * 41},
        ]
        with serving() as s, self.assertLogs("local_audio", level="INFO") as logs:
            responses = [s.request("POST", "/tts", b)[2].decode("utf-8") for b in bad_bodies]
            s.request("POST", "/tts", {**tts_body(text), "reference": {"audio": b64(reference_wav()), "text": ref_text}})  # a success logs nothing private either
        everything = "\n".join(responses + logs.output)
        for secret in (text, ref_text, audio, audio[:40], "secret_field"):
            self.assertNotIn(secret, everything)

    def test_rejects_malformed_bodies(self):
        good = json.dumps(tts_body()).encode("utf-8")
        with serving() as s:
            self.assertEqual(s.request("POST", "/tts", raw=b"")[0], 400)  # an empty body is not JSON
            self.assertEqual(s.request("POST", "/tts", raw=b"{not json")[0], 400)
            self.assertEqual(s.request("POST", "/tts", raw=b"[1, 2]")[0], 400)
            self.assertEqual(s.request("POST", "/tts", raw=b"\xff\xfe")[0], 400)
            self.assertEqual(s.request("POST", "/tts", raw=good, headers={"Content-Type": "text/plain"})[0], 415)
            self.assertEqual(s.request("POST", "/tts", raw=good, headers={"Content-Type": "application/json; charset=utf-8"})[0], 200)

    def test_body_limits_are_4_mb_for_tts_and_64_kb_for_sfx_and_checked_without_reading(self):
        with serving() as s:
            def raw(request: bytes) -> str:
                with socket.create_connection(("127.0.0.1", s.port), timeout=10) as sock:
                    sock.sendall(request)
                    return sock.recv(4096).decode("latin-1").split("\r\n")[0]

            host = f"Host: 127.0.0.1:{s.port}\r\nContent-Type: application/json\r\n"
            # No body is sent in any of these, so a 413 proves the server decided from the header alone.
            self.assertIn("413", raw(f"POST /tts HTTP/1.1\r\n{host}Content-Length: {MAX_TTS_BODY_BYTES + 1}\r\n\r\n".encode()))
            self.assertIn("413", raw(f"POST /sfx HTTP/1.1\r\n{host}Content-Length: {64 * 1024 + 1}\r\n\r\n".encode()))
            self.assertIn("411", raw(f"POST /tts HTTP/1.1\r\n{host}Transfer-Encoding: chunked\r\n\r\n".encode()))
            self.assertIn("411", raw(f"POST /tts HTTP/1.1\r\n{host}\r\n".encode()))  # no Content-Length at all
            # A body over 64 KB is fine for /tts (a 30 s reference is about 1 MB at 16 kHz).
            big = pcm_wav(rate=16_000, frames=16_000 * 30)
            self.assertGreater(len(json.dumps(with_reference(audio=b64(big)))), 64 * 1024)
            self.assertEqual(s.request("POST", "/tts", with_reference(audio=b64(big)))[0], 200)


class CallerChecks(unittest.TestCase):
    def test_refuses_a_foreign_host_header(self):
        with serving() as s:
            for host in ("evil.example", f"evil.example:{s.port}", "127.0.0.1", "0.0.0.0:80"):
                with self.subTest(host=host):
                    status, payload = s.json("GET", "/health", headers={"Host": host})
                    self.assertEqual((status, payload["error"]["code"]), (403, "bad_host"))
            self.assertEqual(s.json("GET", "/health", headers={"Host": f"localhost:{s.port}"})[0], 200)

    def test_refuses_requests_that_carry_an_origin(self):
        with serving() as s:
            for origin in ("https://evil.example", "null"):
                with self.subTest(origin=origin):
                    self.assertEqual(s.json("GET", "/health", headers={"Origin": origin})[1]["error"]["code"], "bad_origin")
                    self.assertEqual(s.json("POST", "/tts", tts_body(), headers={"Origin": origin})[0], 403)

    def test_only_the_documented_methods_and_paths(self):
        with serving() as s:
            self.assertEqual(s.json("GET", "/tts")[0], 405)
            self.assertEqual(s.json("POST", "/health", {})[0], 405)
            self.assertEqual(s.json("PUT", "/tts", {})[0], 405)
            self.assertEqual(s.json("DELETE", "/health")[0], 405)
            self.assertEqual(s.json("GET", "/")[0], 404)
            self.assertEqual(s.json("GET", "/../etc/passwd")[0], 404)
            self.assertEqual(s.json("GET", "/health?x=1")[0], 200)


class TokenTests(unittest.TestCase):
    def test_requires_the_token_on_every_endpoint_when_one_is_set(self):
        with serving(token=TOKEN) as s:
            good = {"Authorization": f"Bearer {TOKEN}"}
            for method, path, body in [("GET", "/health", None), ("POST", "/tts", tts_body()), ("POST", "/sfx", {"prompt": "rain", "durationSec": 1})]:
                with self.subTest(path=path):
                    self.assertEqual(s.request(method, path, body)[0], 401)
                    self.assertEqual(s.request(method, path, body, headers={"Authorization": "Bearer wrong-token-value-1234"})[0], 401)
                    self.assertEqual(s.request(method, path, body, headers={"Authorization": TOKEN})[0], 401)  # missing the scheme
                    self.assertEqual(s.request(method, path, body, headers=good)[0], 200)

    def test_works_without_a_token_when_none_is_configured(self):
        with serving() as s:
            self.assertEqual(s.json("GET", "/health")[0], 200)

    def test_the_token_never_appears_in_a_response_or_a_log_line(self):
        wrong = "wrong-token-value-1234"
        with serving(token=TOKEN) as s, self.assertLogs("local_audio", level="INFO") as logs:
            bodies = [s.request("GET", "/health", headers={"Authorization": f"Bearer {wrong}"}), s.request("GET", "/health", headers={"Authorization": f"Bearer {TOKEN}"}), s.request("GET", "/health")]
            s.request("POST", "/tts", tts_body("A very private line.", seed=-1), headers={"Authorization": f"Bearer {TOKEN}"})
        everything = "\n".join(f"{h} {b.decode('latin-1')}" for _, h, b in bodies) + "\n".join(logs.output)
        self.assertNotIn(TOKEN, everything)
        self.assertNotIn(wrong, everything)


class LoggingTests(unittest.TestCase):
    def test_logs_the_method_path_and_status_only(self):
        with serving() as s, self.assertLogs("local_audio", level="INFO") as logs:
            s.request("POST", "/tts", tts_body("A private line of dialogue."))
            s.request("POST", "/tts", tts_body("Another private line.", seed=-1))
        self.assertEqual(logs.output, ["INFO:local_audio:POST /tts -> 200", "INFO:local_audio:POST /tts -> 400"])


class ModelUseTests(unittest.TestCase):
    def test_runs_one_model_call_at_a_time(self):
        backend = Counting(delay_ms=60)
        with serving(backend=backend) as s:
            threads = [threading.Thread(target=lambda i=i: s.request("POST", "/tts", tts_body(f"Line {i}."))) for i in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(backend.max_active, 1)

    def test_a_request_that_waits_too_long_for_the_model_gets_busy(self):
        backend = FakeBackend(delay_ms=600)
        with serving(backend=backend, queue_timeout_s=0.2) as s:
            first = threading.Thread(target=lambda: s.request("POST", "/tts", tts_body("Slow.")))
            first.start()
            time.sleep(0.15)
            status, payload = s.json("POST", "/tts", tts_body("Waiting."))
            first.join()
        self.assertEqual((status, payload["error"]["code"]), (503, "busy"))

    def test_backend_errors_become_json_errors_and_other_failures_leak_nothing(self):
        with serving(backend=Failing(BackendError("model_failed", "the model could not render this line", 502))) as s:
            status, payload = s.json("POST", "/tts", tts_body())
        self.assertEqual((status, payload), (502, {"error": {"code": "model_failed", "message": "the model could not render this line"}}))

        with serving(backend=Failing(RuntimeError("internal detail: /Users/someone/secret/path"))) as s, self.assertLogs("local_audio", level="ERROR") as logs:
            status, payload = s.json("POST", "/tts", tts_body())
        self.assertEqual((status, payload["error"]["code"]), (500, "internal"))
        self.assertNotIn("secret", str(payload))
        self.assertNotIn("secret", "\n".join(logs.output))  # only the exception type is logged


def design_body(**overrides) -> dict:
    body = {"instruct": "A weary old sailor, gravelly and slow.", "text": "The tide is turning, and so am I.", "language": "English", "seed": 5}
    body.update(overrides)
    return body


class NoDesign(FakeBackend):
    def design_info(self):
        return None


class VoiceDesignTests(unittest.TestCase):
    def test_health_reports_the_design_model_or_null(self):
        with serving() as s:
            body = s.json("GET", "/health")[1]
        self.assertEqual(body["voiceDesign"], {"model": "fake-voice-design", "revision": "fake-design-1", "sampleRate": 24000, "ready": True})
        with serving(backend=NoDesign()) as s:
            self.assertIsNone(s.json("GET", "/health")[1]["voiceDesign"])

    def test_returns_a_wav_with_the_design_revision(self):
        with serving() as s:
            status, headers, data = s.request("POST", "/voice-design", design_body())
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "audio/wav")
        self.assertEqual(headers["x-model-revision"], "fake-design-1")
        self.assertIn("x-render-ms", headers)
        info = wav_info(data)
        self.assertEqual((info["rate"], info["channels"], info["width"], info["frames"]), (24000, 1, 2, 8 * 350 * 24))

    def test_instruct_and_seed_change_the_audio_and_identical_requests_match(self):
        with serving() as s:
            a = s.request("POST", "/voice-design", design_body())[2]
            again = s.request("POST", "/voice-design", design_body())[2]
            other_instruct = s.request("POST", "/voice-design", design_body(instruct="A bright young nurse."))[2]
            other_seed = s.request("POST", "/voice-design", design_body(seed=6))[2]
        self.assertEqual(a, again)
        self.assertNotEqual(a, other_instruct)
        self.assertNotEqual(a, other_seed)

    def test_the_backend_receives_the_request_fields(self):
        seen = []

        class Recording(FakeBackend):
            def render_design(self, request):
                seen.append(request)
                return super().render_design(request)

        with serving(backend=Recording()) as s:
            s.request("POST", "/voice-design", design_body(seed=9, language="French"))
        self.assertEqual(seen, [VoiceDesignRequest(design_body()["instruct"], design_body()["text"], "French", 9)])

    def test_rejects_bad_requests(self):
        def without(key):
            body = design_body()
            del body[key]
            return body

        cases = {
            "no instruct": without("instruct"),
            "blank instruct": design_body(instruct="  "),
            "instruct too long": design_body(instruct="x" * 501),
            "instruct not a string": design_body(instruct=4),
            "no text": without("text"),
            "blank text": design_body(text=" "),
            "text too long": design_body(text="x" * 501),
            "text not a string": design_body(text=None),
            "no language": without("language"),
            "blank language": design_body(language=" "),
            "language too long": design_body(language="x" * 41),
            "no seed": without("seed"),
            "null seed": design_body(seed=None),
            "negative seed": design_body(seed=-1),
            "bool seed": design_body(seed=True),
            "float seed": design_body(seed=1.5),
            "seed too big": design_body(seed=2**31),
            "unknown field": design_body(reference="x"),
        }
        with serving() as s:
            for name, body in cases.items():
                with self.subTest(case=name):
                    got, payload = s.json("POST", "/voice-design", body)
                    self.assertEqual((got, payload["error"]["code"]), (400, "bad_request"))

    def test_limits_are_inclusive(self):
        with serving() as s:
            for body in (design_body(instruct="x" * 500), design_body(text="x" * 500), design_body(language="x" * 40), design_body(seed=0), design_body(seed=2**31 - 1)):
                self.assertEqual(s.request("POST", "/voice-design", body)[0], 200)

    def test_malformed_bodies_and_body_limit(self):
        good = json.dumps(design_body()).encode("utf-8")
        with serving() as s:
            self.assertEqual(s.request("POST", "/voice-design", raw=b"{nope")[0], 400)
            self.assertEqual(s.request("POST", "/voice-design", raw=b"[1]")[0], 400)
            self.assertEqual(s.request("POST", "/voice-design", raw=good, headers={"Content-Type": "text/plain"})[0], 415)

            def raw(request: bytes) -> str:
                with socket.create_connection(("127.0.0.1", s.port), timeout=10) as sock:
                    sock.sendall(request)
                    return sock.recv(4096).decode("latin-1").split("\r\n")[0]

            host = f"Host: 127.0.0.1:{s.port}\r\nContent-Type: application/json\r\n"
            self.assertIn("413", raw(f"POST /voice-design HTTP/1.1\r\n{host}Content-Length: {64 * 1024 + 1}\r\n\r\n".encode()))
            self.assertIn("411", raw(f"POST /voice-design HTTP/1.1\r\n{host}Transfer-Encoding: chunked\r\n\r\n".encode()))
            self.assertIn("411", raw(f"POST /voice-design HTTP/1.1\r\n{host}\r\n".encode()))

    def test_token_origin_and_method(self):
        with serving(token=TOKEN) as s:
            self.assertEqual(s.request("POST", "/voice-design", design_body())[0], 401)
            self.assertEqual(s.request("POST", "/voice-design", design_body(), headers={"Authorization": "Bearer wrong-token-value-1234"})[0], 401)
            self.assertEqual(s.request("POST", "/voice-design", design_body(), headers={"Authorization": f"Bearer {TOKEN}"})[0], 200)
            self.assertEqual(s.request("POST", "/voice-design", design_body(), headers={"Authorization": f"Bearer {TOKEN}", "Origin": "https://evil.example"})[0], 403)
            self.assertEqual(s.request("GET", "/voice-design", headers={"Authorization": f"Bearer {TOKEN}"})[0], 405)

    def test_503_when_the_backend_has_no_design_model(self):
        with serving(backend=NoDesign()) as s:
            status, payload = s.json("POST", "/voice-design", design_body())
            self.assertEqual((status, payload["error"]["code"]), (503, "not_ready"))
            self.assertEqual(s.json("POST", "/voice-design", design_body(seed=-1))[0], 400)  # still validated first

    def test_the_default_backend_method_answers_503(self):
        class Bare(FakeBackend):
            def design_info(self):
                return {"model": "x", "revision": "r", "sampleRate": 24000, "ready": True}

            def render_design(self, request):
                return super(FakeBackend, self).render_design(request)

        with serving(backend=Bare()) as s:
            status, payload = s.json("POST", "/voice-design", design_body())
        self.assertEqual((status, payload["error"]["code"]), (503, "not_ready"))

    def test_shares_the_model_lock_with_tts(self):
        backend = FakeBackend(delay_ms=600)
        with serving(backend=backend, queue_timeout_s=0.2) as s:
            first = threading.Thread(target=lambda: s.request("POST", "/tts", tts_body("Slow.")))
            first.start()
            time.sleep(0.15)
            status, payload = s.json("POST", "/voice-design", design_body())
            first.join()
        self.assertEqual((status, payload["error"]["code"]), (503, "busy"))

    def test_backend_failure_and_logs_never_leak_the_instruct_or_text(self):
        instruct, text = "A secret-voice instruction.", "A very private line of dialogue."

        class Boom(FakeBackend):
            def render_design(self, request):
                raise BackendError("model_failed", "the model could not render this voice", 502)

        with serving(backend=Boom()) as s, self.assertLogs("local_audio", level="INFO") as logs:
            status, payload = s.json("POST", "/voice-design", design_body(instruct=instruct, text=text))
            bad = [s.request("POST", "/voice-design", design_body(instruct=instruct, text=text, seed=-1))[2].decode(), s.request("POST", "/voice-design", design_body(instruct=instruct, text=text, extra=1))[2].decode()]
        self.assertEqual((status, payload["error"]["code"]), (502, "model_failed"))
        everything = json.dumps(payload) + "\n".join(bad + logs.output)
        for secret in (instruct, text, "secret-voice", "private line"):
            self.assertNotIn(secret, everything)
        self.assertIn("INFO:local_audio:POST /voice-design -> 502", logs.output)


class SfxTests(unittest.TestCase):
    def test_returns_a_wav_of_the_requested_length(self):
        with serving() as s:
            status, headers, data = s.request("POST", "/sfx", {"prompt": "heavy wooden door creaking open", "durationSec": 1.5, "seed": 3})
        self.assertEqual(status, 200)
        info = wav_info(data)
        self.assertEqual((info["rate"], info["channels"], info["width"], info["frames"]), (48000, 1, 2, 72000))
        self.assertEqual(headers["x-model-revision"], "fake-1")

    def test_rejects_bad_requests(self):
        with serving() as s:
            for body in [{"prompt": "", "durationSec": 1}, {"prompt": "x" * 501, "durationSec": 1}, {"prompt": "rain"}, {"prompt": "rain", "durationSec": 0.1}, {"prompt": "rain", "durationSec": 31}, {"prompt": "rain", "durationSec": True}, {"prompt": "rain", "durationSec": 1, "style": "x"}]:
                with self.subTest(body=str(body)[:50]):
                    self.assertEqual(s.json("POST", "/sfx", body)[0], 400)


KEY = "ab" * 32
SFX_BODY = {"prompt": "a door creaks", "durationSec": 1, "seed": 4}
class CountingSfx(FakeBackend):
    def __init__(self):
        super().__init__()
        self.calls = 0
    def render_sfx(self, request):
        self.calls += 1
        return super().render_sfx(request)
class FlakySfx(CountingSfx):
    def render_sfx(self, request):
        if self.calls == 0:
            self.calls += 1
            raise BackendError("model_failed", "boom")
        return super().render_sfx(request)
class BlockingSfx(CountingSfx):
    def __init__(self):
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()
    def render_sfx(self, request):
        self.started.set()
        self.release.wait(10)
        return super().render_sfx(request)
def idem(key=KEY):
    return {"Idempotency-Key": key}
class IdempotencyTests(unittest.TestCase):
    def test_health_advertises_idempotency_only_with_an_sfx_model(self):
        with serving() as s:
            self.assertIs(s.json("GET", "/health")[1]["sfx"]["idempotency"], True)
        class NoSfx(FakeBackend):
            def sfx_info(self):
                return None
        with serving(backend=NoSfx()) as s:
            self.assertIsNone(s.json("GET", "/health")[1]["sfx"])
    def test_replay_returns_identical_bytes_without_rendering_again(self):
        backend = CountingSfx()
        with serving(backend=backend) as s:
            a = s.request("POST", "/sfx", SFX_BODY, idem())
            b = s.request("POST", "/sfx", dict(SFX_BODY), idem())
        self.assertEqual((a[0], b[0], backend.calls), (200, 200, 1))
        self.assertEqual(a[2], b[2])
        self.assertNotIn("x-idempotent-replay", a[1])
        self.assertEqual(b[1]["x-idempotent-replay"], "true")
        for h in ("x-model-revision", "x-render-ms"):
            self.assertEqual(a[1][h], b[1][h])
    def test_an_in_progress_duplicate_gets_409_with_retry_after(self):
        backend = BlockingSfx()
        with serving(backend=backend) as s:
            first = []
            t = threading.Thread(target=lambda: first.append(s.request("POST", "/sfx", SFX_BODY, idem())))
            t.start()
            self.assertTrue(backend.started.wait(5))
            status, headers, data = s.request("POST", "/sfx", SFX_BODY, idem())
            self.assertEqual(status, 409)
            self.assertEqual(json.loads(data)["error"]["code"], "in_progress")
            self.assertTrue(headers["retry-after"].isdigit())
            backend.release.set()
            t.join(10)
            self.assertEqual(first[0][0], 200)
            again = s.request("POST", "/sfx", SFX_BODY, idem())
        self.assertEqual((again[0], again[2], backend.calls), (200, first[0][2], 1))
    def test_a_different_body_with_the_same_key_gets_422(self):
        backend = CountingSfx()
        with serving(backend=backend) as s:
            s.request("POST", "/sfx", SFX_BODY, idem())
            for other in ({**SFX_BODY, "seed": 5}, {**SFX_BODY, "prompt": "rain"}, {**SFX_BODY, "durationSec": 2}, {"prompt": "a door creaks", "durationSec": 1}):
                status, body = s.json("POST", "/sfx", other, idem())
                self.assertEqual((status, body["error"]["code"]), (422, "idempotency_mismatch"))
        self.assertEqual(backend.calls, 1)
    def test_a_failed_render_forgets_the_key(self):
        backend = FlakySfx()
        with serving(backend=backend) as s:
            self.assertEqual(s.request("POST", "/sfx", SFX_BODY, idem())[0], 500)
            self.assertEqual(s.request("POST", "/sfx", SFX_BODY, idem())[0], 200)
            replay = s.request("POST", "/sfx", SFX_BODY, idem())
        self.assertEqual((replay[1]["x-idempotent-replay"], backend.calls), ("true", 2))
    def test_malformed_keys_get_400(self):
        with serving() as s:
            for key in ("", "ab" * 31, "ab" * 33, "AB" * 32, "zz" * 32, "ab" * 32 + "x"):
                with self.subTest(key=key):
                    self.assertEqual(s.json("POST", "/sfx", SFX_BODY, idem(key))[0], 400)
    def test_without_the_header_every_request_renders(self):
        backend = CountingSfx()
        with serving(backend=backend) as s:
            a = s.request("POST", "/sfx", SFX_BODY)
            b = s.request("POST", "/sfx", SFX_BODY)
        self.assertEqual((a[0], b[0], backend.calls), (200, 200, 2))
        self.assertNotIn("x-idempotent-replay", b[1])
    def test_caller_checks_run_before_idempotency(self):
        with serving(token=TOKEN) as s:
            self.assertEqual(s.json("POST", "/sfx", SFX_BODY, idem("bad"))[0], 401)
            self.assertEqual(s.json("POST", "/sfx", SFX_BODY, {**idem(), "Origin": "http://x"})[0], 403)
    def test_finished_results_are_bounded_and_the_oldest_is_evicted(self):
        backend = CountingSfx()
        with serving(backend=backend) as s:
            keys = [f"{i:064x}" for i in range(33)]
            for k in keys:
                s.request("POST", "/sfx", SFX_BODY, idem(k))
            self.assertEqual(len(s.server.idempotency._done), 32)
            self.assertEqual(s.request("POST", "/sfx", SFX_BODY, idem(keys[32]))[1].get("x-idempotent-replay"), "true")
            self.assertEqual(backend.calls, 33)
            s.request("POST", "/sfx", SFX_BODY, idem(keys[0]))  # evicted: renders again
        self.assertEqual(backend.calls, 34)
    def test_the_key_never_appears_in_logs_or_bodies(self):
        with serving() as s, self.assertLogs("local_audio", level="INFO") as logs:
            s.request("POST", "/sfx", SFX_BODY, idem())
            _, _, replay_body = s.request("POST", "/sfx", SFX_BODY, idem())
            _, _, err = s.request("POST", "/sfx", {**SFX_BODY, "seed": 9}, idem())
        self.assertEqual(logs.output, ["INFO:local_audio:POST /sfx -> 200", "INFO:local_audio:POST /sfx -> 200", "INFO:local_audio:POST /sfx -> 422"])
        self.assertNotIn(KEY.encode(), err)
if __name__ == "__main__":
    unittest.main()
