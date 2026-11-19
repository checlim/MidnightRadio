import socket
import threading
import time
import unittest

from local_audio import API_VERSION, SERVICE_NAME
from local_audio.backends import BackendError, FakeBackend
from tests.helpers import TRANSCRIPT, VOICES, serving, sha256, wav_info

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
    def test_reports_the_service_models_and_the_hash_of_every_clip(self):
        with serving() as s:
            status, body = s.json("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual((body["service"], body["apiVersion"], body["backend"]), (SERVICE_NAME, API_VERSION, "fake"))
        self.assertEqual(body["tts"], {"model": "fake-tts", "revision": "fake-1", "sampleRate": 24000, "ready": True})
        self.assertEqual(sorted(body["voices"]), sorted(VOICES))
        self.assertEqual(body["voices"]["stub-f1"]["transcriptSha256"], sha256(TRANSCRIPT.encode("utf-8")))
        self.assertRegex(body["voices"]["stub-f1"]["clipSha256"], r"^[0-9a-f]{64}$")


class TtsTests(unittest.TestCase):
    def test_returns_a_complete_24khz_mono_16bit_wav(self):
        with serving() as s:
            status, headers, data = s.request("POST", "/tts", {"voiceId": "stub-f1", "text": "Good evening, listeners."})
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "audio/wav")
        self.assertEqual(headers["x-model-revision"], "fake-1")
        self.assertIn("x-render-ms", headers)
        self.assertEqual(headers["cache-control"], "no-store")
        info = wav_info(data)
        self.assertEqual((info["rate"], info["channels"], info["width"]), (24000, 1, 2))
        self.assertEqual(info["frames"], 3 * 350 * 24)  # three words

    def test_voices_and_text_change_the_audio(self):
        with serving() as s:
            a = s.request("POST", "/tts", {"voiceId": "stub-f1", "text": "Hello there."})[2]
            b = s.request("POST", "/tts", {"voiceId": "stub-m1", "text": "Hello there."})[2]
            c = s.request("POST", "/tts", {"voiceId": "stub-f1", "text": "Hello there, friend."})[2]
            again = s.request("POST", "/tts", {"voiceId": "stub-f1", "text": "Hello there."})[2]
        self.assertNotEqual(a, b)
        self.assertGreater(wav_info(c)["frames"], wav_info(a)["frames"])
        self.assertEqual(a, again)

    def test_accepts_delivery_and_seed(self):
        with serving() as s:
            status, _, _ = s.request("POST", "/tts", {"voiceId": "stub-f1", "text": "Hush.", "delivery": "whisper", "seed": 7})
        self.assertEqual(status, 200)

    def test_rejects_bad_requests_with_a_json_error(self):
        cases = [
            ({"voiceId": "nobody", "text": "Hi"}, 404, "unknown_voice"),
            ({"voiceId": "has space", "text": "Hi"}, 400, "bad_request"),
            ({"text": "Hi"}, 400, "bad_request"),
            ({"voiceId": "stub-f1"}, 400, "bad_request"),
            ({"voiceId": "stub-f1", "text": "   "}, 400, "bad_request"),
            ({"voiceId": "stub-f1", "text": 5}, 400, "bad_request"),
            ({"voiceId": "stub-f1", "text": "x" * 4001}, 400, "bad_request"),
            ({"voiceId": "stub-f1", "text": "Hi", "delivery": "shouting"}, 400, "bad_request"),
            ({"voiceId": "stub-f1", "text": "Hi", "seed": -1}, 400, "bad_request"),
            ({"voiceId": "stub-f1", "text": "Hi", "seed": True}, 400, "bad_request"),
            ({"voiceId": "stub-f1", "text": "Hi", "seed": 2**31}, 400, "bad_request"),
            ({"voiceId": "stub-f1", "text": "Hi", "pitch": 2}, 400, "bad_request"),
        ]
        with serving() as s:
            for body, status, code in cases:
                with self.subTest(body=str(body)[:60]):
                    got, payload = s.json("POST", "/tts", body)
                    self.assertEqual((got, payload["error"]["code"]), (status, code))
                    self.assertIsInstance(payload["error"]["message"], str)

    def test_text_at_the_limit_is_accepted_and_the_limit_is_configurable(self):
        with serving(max_text_chars=10) as s:
            self.assertEqual(s.request("POST", "/tts", {"voiceId": "stub-f1", "text": "x" * 10})[0], 200)
            self.assertEqual(s.request("POST", "/tts", {"voiceId": "stub-f1", "text": "x" * 11})[0], 400)

    def test_rejects_malformed_bodies(self):
        with serving() as s:
            self.assertEqual(s.request("POST", "/tts", raw=b"")[0], 400)  # an empty body is not JSON
            self.assertEqual(s.request("POST", "/tts", raw=b"{not json")[0], 400)
            self.assertEqual(s.request("POST", "/tts", raw=b"[1, 2]")[0], 400)
            self.assertEqual(s.request("POST", "/tts", raw=b"\xff\xfe")[0], 400)
            self.assertEqual(s.request("POST", "/tts", raw=b'{"voiceId": "stub-f1", "text": "Hi"}', headers={"Content-Type": "text/plain"})[0], 415)
            self.assertEqual(s.request("POST", "/tts", raw=b'{"voiceId": "stub-f1", "text": "Hi"}', headers={"Content-Type": "application/json; charset=utf-8"})[0], 200)

    def test_refuses_oversized_and_chunked_bodies_without_reading_them(self):
        with serving() as s:

            def raw(request: bytes) -> str:
                with socket.create_connection(("127.0.0.1", s.port), timeout=10) as sock:
                    sock.sendall(request)
                    return sock.recv(4096).decode("latin-1").split("\r\n")[0]

            host = f"Host: 127.0.0.1:{s.port}\r\nContent-Type: application/json\r\n"
            self.assertIn("413", raw(f"POST /tts HTTP/1.1\r\n{host}Content-Length: 1000000\r\n\r\n".encode()))
            self.assertIn("411", raw(f"POST /tts HTTP/1.1\r\n{host}Transfer-Encoding: chunked\r\n\r\n".encode()))
            self.assertIn("411", raw(f"POST /tts HTTP/1.1\r\n{host}\r\n".encode()))  # no Content-Length at all


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
                    self.assertEqual(s.json("POST", "/tts", {"voiceId": "stub-f1", "text": "Hi"}, headers={"Origin": origin})[0], 403)

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
            for method, path, body in [("GET", "/health", None), ("POST", "/tts", {"voiceId": "stub-f1", "text": "Hi"}), ("POST", "/sfx", {"prompt": "rain", "durationSec": 1})]:
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
            s.request("POST", "/tts", {"voiceId": "nobody", "text": "A very private line."}, headers={"Authorization": f"Bearer {TOKEN}"})
        everything = "\n".join(f"{h} {b.decode('latin-1')}" for _, h, b in bodies) + "\n".join(logs.output)
        self.assertNotIn(TOKEN, everything)
        self.assertNotIn(wrong, everything)


class LoggingTests(unittest.TestCase):
    def test_logs_the_method_path_and_status_only(self):
        with serving() as s, self.assertLogs("local_audio", level="INFO") as logs:
            s.request("POST", "/tts", {"voiceId": "stub-f1", "text": "A private line of dialogue."})
            s.request("POST", "/tts", {"voiceId": "nobody", "text": "Another private line."})
        self.assertEqual(logs.output, ["INFO:local_audio:POST /tts -> 200", "INFO:local_audio:POST /tts -> 404"])


class ModelUseTests(unittest.TestCase):
    def test_runs_one_model_call_at_a_time(self):
        backend = Counting(delay_ms=60)
        with serving(backend=backend) as s:
            threads = [threading.Thread(target=lambda i=i: s.request("POST", "/tts", {"voiceId": "stub-f1", "text": f"Line {i}."})) for i in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(backend.max_active, 1)

    def test_a_request_that_waits_too_long_for_the_model_gets_busy(self):
        backend = FakeBackend(delay_ms=600)
        with serving(backend=backend, queue_timeout_s=0.2) as s:
            first = threading.Thread(target=lambda: s.request("POST", "/tts", {"voiceId": "stub-f1", "text": "Slow."}))
            first.start()
            time.sleep(0.15)
            status, payload = s.json("POST", "/tts", {"voiceId": "stub-f1", "text": "Waiting."})
            first.join()
        self.assertEqual((status, payload["error"]["code"]), (503, "busy"))

    def test_backend_errors_become_json_errors_and_other_failures_leak_nothing(self):
        with serving(backend=Failing(BackendError("model_failed", "the model could not render this line", 502))) as s:
            status, payload = s.json("POST", "/tts", {"voiceId": "stub-f1", "text": "Hi"})
        self.assertEqual((status, payload), (502, {"error": {"code": "model_failed", "message": "the model could not render this line"}}))

        with serving(backend=Failing(RuntimeError("internal detail: /Users/someone/secret/path"))) as s, self.assertLogs("local_audio", level="ERROR") as logs:
            status, payload = s.json("POST", "/tts", {"voiceId": "stub-f1", "text": "Hi"})
        self.assertEqual((status, payload["error"]["code"]), (500, "internal"))
        self.assertNotIn("secret", str(payload))
        self.assertNotIn("secret", "\n".join(logs.output))  # only the exception type is logged


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


if __name__ == "__main__":
    unittest.main()
