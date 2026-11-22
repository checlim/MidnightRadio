"""Tests for qwen_tts_server with a fake model: no GPU, torch, numpy or qwen-tts needed."""

import array
import base64
import http.client
import io
import json
import math
import threading
import unittest
import wave

import qwen_tts_server as q

TOKEN = "t" * 24
SECRET_TEXT = "SECRET-LINE-TEXT-9137"
SECRET_REF_TEXT = "SECRET-REF-TEXT-4471"


def make_wav(channels=1, width=2, rate=24000, seconds=0.5, not_wav=False):
    if not_wav:
        return b"this is not a wav file"
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        n = int(rate * seconds) * channels
        if width == 2:
            w.writeframes(array.array("h", [int(8000 * math.sin(i / 20)) for i in range(n)]).tobytes())
        else:
            w.writeframes(bytes([128 + (i % 50) for i in range(n)]))
    return out.getvalue()


class FakeAdapter:
    def __init__(self):
        self.prompts_created = 0
        self.generate_calls = []
        self.fail = None
        self.rate = 24000
        self.samples = [0.25 * math.sin(i / 10) for i in range(2400)]
        self.hold = None  # threading.Event the generate call waits on
        self.entered = threading.Event()

    def create_prompt(self, samples, sample_rate, ref_text):
        self.prompts_created += 1
        return ("prompt", len(samples), sample_rate)

    def generate(self, text, language, prompt, seed):
        self.entered.set()
        if self.hold is not None:
            self.hold.wait(5)
        self.generate_calls.append((text, language, prompt, seed))
        if self.fail is not None:
            raise self.fail
        return self.samples, self.rate


SECRET_INSTRUCT = "SECRET-VOICE-INSTRUCT-5520"
SECRET_DESIGN_TEXT = "SECRET-DESIGN-TEXT-8841"


class FakeDesignAdapter:
    def __init__(self):
        self.calls = []
        self.fail = None
        self.hold = None
        self.entered = threading.Event()
        self.samples = [0.25 * math.sin(i / 7) for i in range(4800)]
        self.rate = 24000

    def generate_design(self, instruct, text, language, seed):
        self.entered.set()
        if self.hold is not None:
            self.hold.wait(5)
        self.calls.append((instruct, text, language, seed))
        if self.fail is not None:
            raise self.fail
        return self.samples, self.rate


class Harness:
    def __init__(self, adapter=None, load=True, queue_timeout_s=5.0, token=TOKEN, design=True, design_device=None, design_load=True, design_dtype=None):
        self.adapter = adapter or FakeAdapter()
        self.design_adapter = FakeDesignAdapter()
        self.release_load = threading.Event()
        self.release_design_load = threading.Event()

        def loader(config):
            self.release_load.wait(5)
            return q.LoadedModel(self.adapter, "rev123", "ab" * 32)

        def design_loader(config):
            self.release_design_load.wait(5)
            return q.LoadedModel(self.design_adapter, "designrev9", "cd" * 32)

        config = q.Config(token, port=0, queue_timeout_s=queue_timeout_s, design_device=design_device if design else "none", design_dtype=design_dtype)
        self.server = q.Server(config, load_model=loader, load_design_model=design_loader)
        if load:
            self.release_load.set()
        if design_load:
            self.release_design_load.set()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.server.start_loading()
        if load:
            assert self.server.loaded.wait(5)
        if design and design_load:
            assert self.server.design_loaded.wait(5)

    def design(self, **overrides):
        body = {"instruct": "A weary old sailor.", "text": "The tide is turning.", "language": "English", "seed": 11}
        body.update(overrides)
        return self.request("POST", "/voice-design", body)

    def request(self, method, path, body=None, headers=None, auth=True, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=10)
        hdrs = dict(headers or {})
        if auth:
            hdrs.setdefault("Authorization", f"Bearer {TOKEN}")
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=hdrs)
        resp = conn.getresponse()
        payload = resp.read()
        conn.close()
        return resp.status, dict(resp.getheaders()), payload

    def tts(self, **overrides):
        body = {"text": "Hello there.", "language": "English", "seed": 7, "reference": {"audio": base64.b64encode(make_wav()).decode(), "text": "Good evening."}}
        body.update(overrides)
        return self.request("POST", "/tts", body)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class TestBase(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.addCleanup(self.h.close)

    def assertError(self, result, status, code):
        got_status, _, payload = result
        self.assertEqual(got_status, status, payload)
        self.assertEqual(json.loads(payload)["error"]["code"], code)


class TestStartup(unittest.TestCase):
    def test_token_required(self):
        for token in (None, "", "short"):
            with self.assertRaises(q.ConfigError):
                q.validate_token(token)
            with self.assertRaises(q.ConfigError):
                q.Server(q.Config(token, port=0))  # type: ignore[arg-type]
        self.assertEqual(q.validate_token("x" * 16), "x" * 16)

    def test_cli_refuses_without_token(self):
        import os
        from unittest import mock

        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(q.TOKEN_ENV, None)
            self.assertEqual(q.main(["serve", "--port", "0"]), 2)

    def test_cli_defaults(self):
        args = q.build_parser().parse_args(["serve"])
        self.assertEqual((args.port, args.dtype, args.attn, args.device), (8765, "float32", "sdpa", "cuda:0"))
        self.assertEqual((args.design_device, args.design_dtype, args.design_model_dir), (None, None, None))
    def test_design_cli_options_and_defaults(self):
        args = q.build_parser().parse_args(["serve", "--design-device", "none", "--design-dtype", "float16", "--design-model-dir", "/m"])
        self.assertEqual((args.design_device, args.design_dtype, args.design_model_dir), ("none", "float16", "/m"))
        self.assertEqual(q.build_parser().parse_args(["bench", "--reference", "a", "--reference-text", "b", "--design", "x"]).design, "x")
        self.assertEqual(q.resolve_design_device("cuda:1", "cuda:0"), "cuda:1")
        self.assertEqual(q.resolve_design_device("none", "cuda:0"), "none")
        from unittest import mock
        torch = mock.MagicMock()
        for count, expected in ((2, "cuda:1"), (1, "cuda:0"), (0, "cuda:0")):
            torch.cuda.device_count.return_value = count
            with mock.patch.dict("sys.modules", {"torch": torch}):
                self.assertEqual(q.resolve_design_device(None, "cuda:0"), expected)
    def test_design_model_name_carries_dtype(self):
        self.assertEqual(q.reported_design_model_name("bfloat16"), "Qwen3-TTS-12Hz-1.7B-VoiceDesign")
        self.assertEqual(q.reported_design_model_name("float16"), "Qwen3-TTS-12Hz-1.7B-VoiceDesign (float16)")
    def test_design_pins(self):
        self.assertEqual(q.DESIGN_REVISION, "5ecdb67327fd37bb2e042aab12ff7391903235d3")
        self.assertEqual(q.DESIGN_EXPECTED_WEIGHTS_SHA256, "391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522")
        self.assertEqual(q.DESIGN_REPO_ID, "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")

    def test_model_name_carries_dtype(self):
        self.assertEqual(q.reported_model_name("bfloat16"), "Qwen3-TTS-12Hz-1.7B-Base")
        self.assertEqual(q.reported_model_name("float32"), "Qwen3-TTS-12Hz-1.7B-Base (float32)")

    def test_revision_from_snapshot_path(self):
        from pathlib import Path

        self.assertEqual(q.revision_of(Path("/x/models--a--b/snapshots/abc123")), "abc123")
        self.assertEqual(q.revision_of(Path("/somewhere/else")), q.REVISION)


class TestAuthAndHealth(TestBase):
    def test_every_endpoint_requires_token(self):
        for method, path in (("GET", "/health"), ("POST", "/tts"), ("POST", "/voice-design")):
            self.assertError(self.h.request(method, path, auth=False, body={} if method == "POST" else None), 401, "unauthorized")
            self.assertError(self.h.request(method, path, headers={"Authorization": "Bearer " + "x" * 24}, body={} if method == "POST" else None), 401, "unauthorized")

    def test_origin_refused(self):
        self.assertError(self.h.request("GET", "/health", headers={"Origin": "https://evil.example"}), 403, "bad_origin")

    def test_host_header_not_checked(self):
        status, _, _ = self.h.request("GET", "/health", headers={"Host": "something.trycloudflare.com"})
        self.assertEqual(status, 200)

    def test_not_found_and_method(self):
        self.assertError(self.h.request("GET", "/nope"), 404, "not_found")
        self.assertError(self.h.request("GET", "/tts"), 405, "method_not_allowed")

    def test_health_ready(self):
        status, _, payload = self.h.request("GET", "/health")
        info = json.loads(payload)
        self.assertEqual(status, 200)
        self.assertEqual(info["apiVersion"], 1)
        tts = info["tts"]
        self.assertEqual(tts["model"], "Qwen3-TTS-12Hz-1.7B-Base (float32)")
        self.assertEqual((tts["revision"], tts["weightsSha256"], tts["sampleRate"], tts["dtype"], tts["ready"]), ("rev123", "ab" * 32, 24000, "float32", True))
        self.assertEqual(
            info["voiceDesign"],
            {"model": "Qwen3-TTS-12Hz-1.7B-VoiceDesign (float32)", "revision": "designrev9", "weightsSha256": "cd" * 32, "sampleRate": 24000, "dtype": "float32", "ready": True},
        )

    def test_health_and_tts_before_ready(self):
        h = Harness(load=False)
        self.addCleanup(h.close)
        status, _, payload = h.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(payload)["tts"]["ready"])
        self.assertError(h.tts(), 503, "not_ready")
        h.release_load.set()
        self.assertTrue(h.server.loaded.wait(5))
        self.assertTrue(json.loads(h.request("GET", "/health")[2])["tts"]["ready"])
        self.assertEqual(h.tts()[0], 200)


class TestDesignHealth(unittest.TestCase):
    def test_design_disabled_reports_null_and_503(self):
        h = Harness(design=False)
        self.addCleanup(h.close)
        self.assertIsNone(json.loads(h.request("GET", "/health")[2])["voiceDesign"])
        status, _, payload = h.design()
        self.assertEqual((status, json.loads(payload)["error"]["code"]), (503, "not_ready"))
        self.assertEqual(h.tts()[0], 200)
    def test_readiness_is_per_model(self):
        h = Harness(design_load=False)
        self.addCleanup(h.close)
        info = json.loads(h.request("GET", "/health")[2])
        self.assertEqual((info["tts"]["ready"], info["voiceDesign"]["ready"]), (True, False))
        self.assertEqual(h.tts()[0], 200)
        self.assertEqual((h.design()[0], json.loads(h.design()[2])["error"]["code"]), (503, "not_ready"))
        h.release_design_load.set()
        self.assertTrue(h.server.design_loaded.wait(5))
        self.assertTrue(json.loads(h.request("GET", "/health")[2])["voiceDesign"]["ready"])
        self.assertEqual(h.design()[0], 200)
    def test_tts_not_ready_while_design_is_ready(self):
        h = Harness(load=False)
        self.addCleanup(h.close)
        info = json.loads(h.request("GET", "/health")[2])
        self.assertEqual((info["tts"]["ready"], info["voiceDesign"]["ready"]), (False, True))
        self.assertEqual(h.design()[0], 200)
        self.assertEqual(json.loads(h.tts()[2])["error"]["code"], "not_ready")
        h.release_load.set()
    def test_design_dtype_defaults_to_dtype_and_can_differ(self):
        h = Harness(design_dtype="float16")
        self.addCleanup(h.close)
        info = json.loads(h.request("GET", "/health")[2])
        self.assertEqual(info["voiceDesign"]["model"], "Qwen3-TTS-12Hz-1.7B-VoiceDesign (float16)")
        self.assertEqual(info["tts"]["dtype"], "float32")
    def test_a_failed_design_load_stays_not_ready(self):
        def broken(config):
            raise RuntimeError("no weights")
        server = q.Server(q.Config(TOKEN, port=0), load_model=lambda c: q.LoadedModel(FakeAdapter(), "r", "ab" * 32), load_design_model=broken)
        self.addCleanup(server.server_close)
        with self.assertLogs("qwen_tts_server", level="ERROR"):
            server.start_loading()
            for _ in range(100):
                if server.design_load_failed:
                    break
                threading.Event().wait(0.05)
        self.assertTrue(server.design_load_failed)
        self.assertFalse(server.design_info()["ready"])
class TestVoiceDesign(TestBase):
    def test_success_wav_headers_and_seed_passthrough(self):
        status, headers, payload = self.h.design(seed=12345, language="French", instruct="A bright nurse.", text="Bonjour.")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(headers["X-Model-Revision"], "designrev9")
        self.assertTrue(headers["X-Render-Ms"].isdigit())
        with wave.open(io.BytesIO(payload), "rb") as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()), (24000, 1, 2, 4800))
        self.assertEqual(self.h.design_adapter.calls[-1], ("A bright nurse.", "Bonjour.", "French", 12345))
        self.assertEqual(self.h.adapter.generate_calls, [])
    def test_field_refusals(self):
        cases = {
            "unknown field": {"extra": 1},
            "blank instruct": {"instruct": "  "},
            "instruct too long": {"instruct": "x" * 501},
            "instruct not a string": {"instruct": 4},
            "blank text": {"text": " "},
            "text too long": {"text": "x" * 501},
            "text not a string": {"text": None},
            "blank language": {"language": " "},
            "language too long": {"language": "x" * 41},
            "language not a string": {"language": 3},
            "negative seed": {"seed": -1},
            "seed too big": {"seed": 2**31},
            "bool seed": {"seed": True},
            "float seed": {"seed": 1.5},
            "null seed": {"seed": None},
        }
        for name, overrides in cases.items():
            with self.subTest(name):
                self.assertError(self.h.design(**overrides), 400, "bad_request")
        for key in ("instruct", "text", "language", "seed"):
            with self.subTest(missing=key):
                body = {"instruct": "a", "text": "b", "language": "English", "seed": 1}
                del body[key]
                self.assertError(self.h.request("POST", "/voice-design", body), 400, "bad_request")
        self.assertEqual(self.h.design(instruct="x" * 500, text="y" * 500, language="z" * 40, seed=0)[0], 200)
        self.assertEqual(self.h.design(seed=2**31 - 1)[0], 200)
    def test_body_shape_errors(self):
        json_type = {"Content-Type": "application/json"}
        self.assertError(self.h.request("POST", "/voice-design", raw=b"{nope", headers=json_type), 400, "bad_request")
        self.assertError(self.h.request("POST", "/voice-design", raw=b"[1]", headers=json_type), 400, "bad_request")
        self.assertError(self.h.request("POST", "/voice-design", raw=b"{}", headers={"Content-Type": "text/plain"}), 415, "unsupported_media_type")
    def test_too_large_over_64_kb_is_refused_without_reading(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.h.server.port, timeout=5)
        conn.putrequest("POST", "/voice-design")
        conn.putheader("Authorization", f"Bearer {TOKEN}")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(64 * 1024 + 1))
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(resp.status, 413)
        self.assertEqual(json.loads(resp.read())["error"]["code"], "too_large")
        conn.close()
        # 64 KB is a limit for this route only; /tts still takes up to 4 MB.
        self.assertEqual(self.h.tts(text="x" * 10)[0], 200)
    def test_chunked_and_missing_length_refused(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.h.server.port, timeout=5)
        conn.request("POST", "/voice-design", body=iter([b"{}"]), headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "Transfer-Encoding": "chunked"}, encode_chunked=True)
        self.assertEqual(conn.getresponse().status, 411)
        conn.close()
        conn = http.client.HTTPConnection("127.0.0.1", self.h.server.port, timeout=5)
        conn.putrequest("POST", "/voice-design")
        conn.putheader("Authorization", f"Bearer {TOKEN}")
        conn.putheader("Content-Type", "application/json")
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 411)
        conn.close()
    def test_token_origin_and_method(self):
        self.assertError(self.h.request("POST", "/voice-design", {"instruct": "a"}, auth=False), 401, "unauthorized")
        self.assertError(self.h.request("POST", "/voice-design", {}, headers={"Origin": "https://evil.example"}), 403, "bad_origin")
        self.assertError(self.h.request("GET", "/voice-design"), 405, "method_not_allowed")
    def test_model_exception_is_502_without_leak(self):
        self.h.design_adapter.fail = RuntimeError(f"boom {SECRET_INSTRUCT} {SECRET_DESIGN_TEXT}")
        with self.assertLogs("qwen_tts_server", level="DEBUG") as logs:
            result = self.h.design(instruct=SECRET_INSTRUCT, text=SECRET_DESIGN_TEXT)
        self.assertError(result, 502, "model_failed")
        joined = "\n".join(logs.output) + result[2].decode()
        for secret in (SECRET_INSTRUCT, SECRET_DESIGN_TEXT, "boom"):
            self.assertNotIn(secret, joined)
    def test_out_of_memory_is_503_busy(self):
        self.h.design_adapter.fail = q.OutOfMemory()
        self.assertError(self.h.design(), 503, "busy")
    def test_bad_model_output_is_502(self):
        for samples, rate in (([], 24000), ([0.0] * 100, 24000), ([float("nan")] * 10, 24000), ([0.3] * 100, 16000)):
            with self.subTest(len=len(samples), rate=rate):
                self.h.design_adapter.samples, self.h.design_adapter.rate = samples, rate
                self.assertError(self.h.design(), 502, "model_failed")
    def test_logs_and_errors_hold_no_instruct_or_text(self):
        with self.assertLogs("qwen_tts_server", level="DEBUG") as logs:
            ok = self.h.design(instruct=SECRET_INSTRUCT, text=SECRET_DESIGN_TEXT)
            bad = [self.h.design(instruct=SECRET_INSTRUCT, text=SECRET_DESIGN_TEXT, seed=-1), self.h.design(instruct=SECRET_INSTRUCT, text=SECRET_DESIGN_TEXT, **{SECRET_INSTRUCT: 1}), self.h.design(instruct=SECRET_INSTRUCT, text="x" * 501)]
        self.assertEqual(ok[0], 200)
        joined = "\n".join(logs.output) + "".join(b[2].decode() for b in bad)
        for secret in (SECRET_INSTRUCT, SECRET_DESIGN_TEXT):
            self.assertNotIn(secret, joined)
        self.assertIn("POST /voice-design -> 200", joined)
class TestLocks(unittest.TestCase):
    def test_different_devices_use_separate_locks_and_run_together(self):
        h = Harness(design_device="cuda:1", queue_timeout_s=0.3)
        self.addCleanup(h.close)
        self.assertIsNot(h.server.design_lock, h.server.model_lock)
        h.design_adapter.hold = threading.Event()
        first = []
        t = threading.Thread(target=lambda: first.append(h.design()[0]))
        t.start()
        self.assertTrue(h.design_adapter.entered.wait(5))
        self.assertEqual(h.tts()[0], 200)  # the clone finishes while the design is still blocked
        h.design_adapter.hold.set()
        t.join(5)
        self.assertEqual(first, [200])
    def test_same_device_shares_one_lock(self):
        h = Harness(queue_timeout_s=0.2)
        self.addCleanup(h.close)
        self.assertIs(h.server.design_lock, h.server.model_lock)
        h.design_adapter.hold = threading.Event()
        first = []
        t = threading.Thread(target=lambda: first.append(h.design()[0]))
        t.start()
        self.assertTrue(h.design_adapter.entered.wait(5))
        status, _, payload = h.tts()
        self.assertEqual((status, json.loads(payload)["error"]["code"]), (503, "busy"))
        h.design_adapter.hold.set()
        t.join(5)
        self.assertEqual(first, [200])
    def test_explicit_same_device_also_shares(self):
        h = Harness(design_device="cuda:0")
        self.addCleanup(h.close)
        self.assertIs(h.server.design_lock, h.server.model_lock)
class TestBench(unittest.TestCase):
    def test_bench_design_saves_a_wav(self):
        import tempfile
        from pathlib import Path
        from unittest import mock
        with tempfile.TemporaryDirectory() as tmp:
            ref = Path(tmp) / "ref.wav"
            ref.write_bytes(make_wav())
            adapter, design_adapter = FakeAdapter(), FakeDesignAdapter()
            config = q.Config("t" * 24, port=0)
            with mock.patch("builtins.print"):
                q.run_bench(config, str(ref), "Good evening.", tmp, load_model=lambda c: q.LoadedModel(adapter, "r", "s"), design="A weary sailor.", load_design_model=lambda c: q.LoadedModel(design_adapter, "d", "s"))
            self.assertTrue((Path(tmp) / "bench-design.wav").is_file())
            self.assertEqual(design_adapter.calls[0][0], "A weary sailor.")
            self.assertFalse(any(c[0] == "A weary sailor." for c in adapter.generate_calls))
    def test_bench_design_needs_a_design_model(self):
        config = q.Config("t" * 24, port=0, design_device="none")
        with self.assertRaises(q.ConfigError):
            q.run_bench(config, "x.wav", "t", "/tmp/unused", design="A voice.")
class TestTts(TestBase):
    def test_success_wav_and_headers(self):
        status, headers, payload = self.h.tts()
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(headers["X-Model-Revision"], "rev123")
        self.assertTrue(headers["X-Render-Ms"].isdigit())
        with wave.open(io.BytesIO(payload), "rb") as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()), (24000, 1, 2, 2400))

    def test_seed_and_fields_passed_through(self):
        self.h.tts(seed=12345, language="French", text="Bonjour.")
        text, language, _, seed = self.h.adapter.generate_calls[-1]
        self.assertEqual((text, language, seed), ("Bonjour.", "French", 12345))

    def test_prompt_cache(self):
        self.h.tts()
        self.h.tts(text="Another line.")
        self.assertEqual(self.h.adapter.prompts_created, 1)
        other = {"audio": base64.b64encode(make_wav(seconds=0.6)).decode(), "text": "Good evening."}
        self.h.tts(reference=other)
        self.assertEqual(self.h.adapter.prompts_created, 2)
        same_audio_other_text = {"audio": other["audio"], "text": "Different words."}
        self.h.tts(reference=same_audio_other_text)
        self.assertEqual(self.h.adapter.prompts_created, 3)

    def test_prompt_cache_is_bounded(self):
        r = q.Renderer(self.h.adapter, cache_size=2)
        for i in range(4):
            ref = q.Reference(array.array("f", [0.1]), 24000, f"k{i}")
            r.render("x", "English", 0, ref, "t")
        self.assertEqual(len(r.prompts), 2)

    def test_bad_base64(self):
        self.assertError(self.h.tts(reference={"audio": "not base64!!", "text": "x"}), 400, "bad_request")

    def test_bad_references(self):
        cases = {
            "stereo": make_wav(channels=2),
            "8-bit": make_wav(width=1),
            "too long": make_wav(rate=8000, seconds=31),
            "not wav": make_wav(not_wav=True),
        }
        for name, wav in cases.items():
            with self.subTest(name):
                ref = {"audio": base64.b64encode(wav).decode(), "text": "x"}
                self.assertError(self.h.tts(reference=ref), 400, "bad_request")

    def test_thirty_seconds_accepted(self):
        ref = {"audio": base64.b64encode(make_wav(rate=8000, seconds=30)).decode(), "text": "x"}
        self.assertEqual(self.h.tts(reference=ref)[0], 200)

    def test_field_refusals(self):
        self.assertError(self.h.tts(extra=1), 400, "bad_request")
        self.assertError(self.h.tts(text="   "), 400, "bad_request")
        self.assertError(self.h.tts(text="a" * 4001), 400, "bad_request")
        self.assertEqual(self.h.tts(text="a" * 4000)[0], 200)
        self.assertError(self.h.tts(seed=-1), 400, "bad_request")
        self.assertError(self.h.tts(seed=2**31), 400, "bad_request")
        self.assertError(self.h.tts(seed=True), 400, "bad_request")
        self.assertError(self.h.tts(seed=None), 400, "bad_request")  # required, as the contract says
        self.assertError(self.h.tts(reference={"audio": "AAAA", "text": ""}), 400, "bad_request")
        self.assertError(self.h.tts(reference={"audio": "AAAA", "text": "x" * 501}), 400, "bad_request")
        self.assertError(self.h.tts(reference={"audio": "AAAA", "text": "x", "more": 1}), 400, "bad_request")

    def test_invalid_json(self):
        self.assertError(self.h.request("POST", "/tts", raw=b"{nope", headers={"Content-Type": "application/json"}), 400, "bad_request")
        self.assertError(self.h.request("POST", "/tts", raw=b"[1]", headers={"Content-Type": "application/json"}), 400, "bad_request")

    def test_too_large_is_refused_without_reading(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.h.server.port, timeout=5)
        conn.putrequest("POST", "/tts")
        conn.putheader("Authorization", f"Bearer {TOKEN}")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(4 * 1024 * 1024 + 1))
        conn.endheaders()  # no body is ever sent
        resp = conn.getresponse()
        self.assertEqual(resp.status, 413)
        self.assertEqual(json.loads(resp.read())["error"]["code"], "too_large")
        conn.close()

    def test_chunked_refused(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.h.server.port, timeout=5)
        conn.request("POST", "/tts", body=iter([b"{}"]), headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "Transfer-Encoding": "chunked"}, encode_chunked=True)
        resp = conn.getresponse()
        self.assertEqual(resp.status, 411)
        conn.close()

    def test_missing_content_length(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.h.server.port, timeout=5)
        conn.putrequest("POST", "/tts")
        conn.putheader("Authorization", f"Bearer {TOKEN}")
        conn.putheader("Content-Type", "application/json")
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 411)
        conn.close()

    def test_unsupported_media_type(self):
        self.assertError(self.h.request("POST", "/tts", raw=b"{}", headers={"Content-Type": "text/plain"}), 415, "unsupported_media_type")


class TestFailures(TestBase):
    def test_model_exception_is_502_without_leak(self):
        self.h.adapter.fail = RuntimeError(f"boom {SECRET_TEXT} {SECRET_REF_TEXT}")
        with self.assertLogs("qwen_tts_server", level="DEBUG") as logs:
            result = self.h.tts(text=SECRET_TEXT, reference={"audio": base64.b64encode(make_wav()).decode(), "text": SECRET_REF_TEXT})
        self.assertError(result, 502, "model_failed")
        self.assertNotIn(SECRET_TEXT.encode(), result[2])
        self.assertNotIn(b"boom", result[2])
        joined = "\n".join(logs.output)
        self.assertNotIn(SECRET_TEXT, joined)
        self.assertNotIn(SECRET_REF_TEXT, joined)

    def test_out_of_memory_is_503_busy(self):
        self.h.adapter.fail = q.OutOfMemory()
        self.assertError(self.h.tts(), 503, "busy")

    def test_bad_model_output_is_502(self):
        for samples, rate in (([], 24000), ([0.0] * 100, 24000), ([float("nan")] * 10, 24000), ([0.3] * 100, 16000)):
            with self.subTest(len=len(samples), rate=rate):
                self.h.adapter.samples, self.h.adapter.rate = samples, rate
                self.assertError(self.h.tts(), 502, "model_failed")

    def test_busy_when_lock_held_past_queue_timeout(self):
        h = Harness(queue_timeout_s=0.2)
        self.addCleanup(h.close)
        h.adapter.hold = threading.Event()
        first = []
        t = threading.Thread(target=lambda: first.append(h.tts()[0]))
        t.start()
        self.assertTrue(h.adapter.entered.wait(5))
        self.assertError(h.tts(), 503, "busy")
        h.adapter.hold.set()
        t.join(5)
        self.assertEqual(first, [200])

    def test_logs_hold_no_request_content(self):
        with self.assertLogs("qwen_tts_server", level="DEBUG") as logs:
            self.h.tts(text=SECRET_TEXT, reference={"audio": base64.b64encode(make_wav()).decode(), "text": SECRET_REF_TEXT})
            self.h.tts(text="  ")
            self.h.request("GET", "/health", auth=False)
        joined = "\n".join(logs.output)
        for secret in (SECRET_TEXT, SECRET_REF_TEXT, TOKEN):
            self.assertNotIn(secret, joined)
        self.assertIn("POST /tts -> 200", joined)
        self.assertIn("GET /health -> 401", joined)


if __name__ == "__main__":
    unittest.main()
