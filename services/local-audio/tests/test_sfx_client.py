"""The sound-effect API client and the foley generation tool (docs/sfx-service-api.md)."""
import json
import struct
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from local_audio.backends.fake import FakeBackend
from local_audio.sfx_client import (
    ClientConfig,
    ModelInfo,
    SfxClient,
    SfxClientError,
    SfxFatalError,
    check_url,
    load_config,
    parse_health,
    parse_wav,
)
from local_audio.wav import encode_pcm16, encode_wav
from tests.helpers import serving
from tools.generate_sfx import PROMPTS, PromptsError, listening_page, load_prompts, run

TOKEN = "s3cret-token-0123456789"
HEALTH = {"apiVersion": 1, "sfx": {"model": "stub-sfx", "revision": "rev-1", "license": "CC0-1.0", "sampleRate": 48000, "ready": True}}
MODEL = ModelInfo("stub-sfx", "rev-1", None, "CC0-1.0", 48000)


def noise(seconds: float, rate: int = 48000) -> bytes:
    return encode_wav([((i * 7919) % 2000) - 1000 for i in range(int(seconds * rate))], rate)


def no_sleep(_s: float) -> None:
    pass


class StubServer:
    """A scripted sound-effect server: `health` is the /health body; `sfx` returns (status, headers, body) per request."""

    def __init__(self):
        self.health = json.loads(json.dumps(HEALTH))
        self.sfx = lambda body: (200, {"Content-Type": "audio/wav", "X-Model-Revision": "rev-1"}, noise(body["durationSec"]))
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _send(self, status, headers, body):
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                stub.requests.append(("GET", self.path, dict(self.headers), None))
                self._send(200, {"Content-Type": "application/json"}, json.dumps(stub.health).encode())

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                stub.requests.append(("POST", self.path, dict(self.headers), body))
                self._send(*stub.sfx(body))

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def client(self, token=None) -> SfxClient:
        return SfxClient(ClientConfig(self.url, token, 10), sleep=no_sleep)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ConfigTests(unittest.TestCase):
    def test_plain_http_only_on_loopback_and_remote_needs_https_and_a_token(self):
        for url in ["http://127.0.0.1:8765", "http://localhost:9000/", "http://[::1]:8765"]:
            self.assertEqual(check_url(url, None), url.rstrip("/"))
        self.assertEqual(check_url("https://abc.trycloudflare.com/", TOKEN), "https://abc.trycloudflare.com")
        for url, token, fragment in [
            ("http://abc.trycloudflare.com", TOKEN, "must use https"),
            ("http://192.168.1.5:8765", TOKEN, "must use https"),
            ("https://abc.trycloudflare.com", None, "needs SFX_SERVICE_TOKEN"),
            ("https://user:pw@abc.example", TOKEN, "credentials"),
            ("https://abc.example/?key=1", TOKEN, "query"),
            ("ftp://abc.example", TOKEN, "http or https"),
            ("http://127.0.0.1:99999", None, "not a valid URL"),
        ]:
            with self.subTest(url=url), self.assertRaises(SfxFatalError) as caught:
                check_url(url, token)
            self.assertIn(fragment, str(caught.exception))

    def test_environment_settings(self):
        config = load_config({"SFX_SERVICE_URL": "https://x.example", "SFX_SERVICE_TOKEN": TOKEN, "SFX_SERVICE_TIMEOUT_MS": "120000"})
        self.assertEqual((config.base_url, config.token, config.timeout_s), ("https://x.example", TOKEN, 120.0))
        self.assertEqual(load_config({"SFX_SERVICE_URL": "http://127.0.0.1:8765"}).timeout_s, 900.0)
        for env, fragment in [
            ({}, "set SFX_SERVICE_URL"),
            ({"SFX_SERVICE_URL": "https://x.example", "SFX_SERVICE_TOKEN": "short"}, "at least 16"),
            ({"SFX_SERVICE_URL": "https://x.example", "SFX_SERVICE_TOKEN": "has a space in it ok"}, "no spaces"),
            ({"SFX_SERVICE_URL": "http://127.0.0.1", "SFX_SERVICE_TIMEOUT_MS": "ten"}, "whole number"),
            ({"SFX_SERVICE_URL": "http://127.0.0.1", "SFX_SERVICE_TIMEOUT_MS": "10"}, "between"),
        ]:
            with self.subTest(env=env), self.assertRaises(SfxFatalError) as caught:
                load_config(env)
            self.assertIn(fragment, str(caught.exception))


class WavTests(unittest.TestCase):
    def test_accepts_complete_mono_16_bit_pcm(self):
        info = parse_wav(noise(1.5))
        self.assertEqual((info.sample_rate, info.frames), (48000, 72000))
        self.assertGreater(info.peak, 0)

    def test_refuses_anything_else(self):
        good = noise(0.5)
        stereo = bytearray(good)
        struct.pack_into("<HHIIHH", stereo, 20, 1, 2, 48000, 192000, 4, 16)
        eight_bit = bytearray(good)
        struct.pack_into("<HHIIHH", eight_bit, 20, 1, 1, 48000, 48000, 1, 8)
        float_fmt = bytearray(good)
        struct.pack_into("<H", float_fmt, 20, 3)
        streamed = bytearray(good)
        struct.pack_into("<I", streamed, 4, 0xFFFFFFFF)
        cases = {
            "not a WAV": b"<html>oops</html>" * 10,
            "truncated": good[:-100],
            "padded": good + b"\0\0",
            "streamed size": bytes(streamed),
            "stereo": bytes(stereo),
            "8-bit": bytes(eight_bit),
            "float": bytes(float_fmt),
            "silent": encode_pcm16(b"\0\0" * 1000, 48000),
            "odd data": encode_pcm16(b"\1\0" * 10, 48000)[:-2] + b"\1",
        }
        for label, data in cases.items():
            with self.subTest(label), self.assertRaises(SfxClientError):
                parse_wav(data)


class HealthTests(unittest.TestCase):
    def parse(self, mutate):
        body = json.loads(json.dumps(HEALTH))
        mutate(body)
        return parse_health(json.dumps(body).encode())

    def test_reads_the_model_and_waits_while_not_ready(self):
        self.assertEqual(self.parse(lambda b: None), MODEL)
        self.assertEqual(self.parse(lambda b: b["sfx"].update(weightsSha256="a" * 64)).weights_sha256, "a" * 64)
        self.assertIsNone(self.parse(lambda b: b["sfx"].update(ready=False)))

    def test_refuses_a_non_conforming_server(self):
        cases = [
            (lambda b: b.update(apiVersion=2), "version 1"),
            (lambda b: b.update(apiVersion=True), "version 1"),
            (lambda b: b.update(sfx=None), "no sound-effect model"),
            (lambda b: b["sfx"].pop("license"), "license"),
            (lambda b: b["sfx"].update(revision="  "), "revision"),
            (lambda b: b["sfx"].update(weightsSha256="ABC"), "weightsSha256"),
            (lambda b: b["sfx"].update(sampleRate=True), "sampleRate"),
            (lambda b: b["sfx"].update(sampleRate=8000), "sampleRate"),
            (lambda b: b["sfx"].update(ready="yes"), "ready"),
        ]
        for mutate, fragment in cases:
            with self.subTest(fragment), self.assertRaises(SfxFatalError) as caught:
                self.parse(mutate)
            self.assertIn(fragment, str(caught.exception))
        with self.assertRaises(SfxFatalError):
            parse_health(b"<html>")


class AgainstTheLocalServiceTests(unittest.TestCase):
    """The reference server (services/local-audio, fake backend) conforms to the API."""

    def test_health_and_render(self):
        with serving(FakeBackend()) as s:
            client = SfxClient(ClientConfig(f"http://127.0.0.1:{s.port}", None, 10), sleep=no_sleep)
            model = client.health()
            self.assertEqual(model.identity(), {"model": "fake-sfx", "revision": "fake-1", "weightsSha256": None, "license": "CC0-1.0", "sampleRate": 48000})
            wav, info, render_ms = client.render("rain on a window", 1.5, 7, model)
            self.assertEqual((info.sample_rate, info.frames), (48000, 72000))
            self.assertIsInstance(render_ms, int)
            self.assertEqual(client.render("rain on a window", 1.5, 7, model)[0], wav)  # same seed, same audio

    def test_token(self):
        with serving(FakeBackend(), token=TOKEN) as s:
            self.assertEqual(SfxClient(ClientConfig(f"http://127.0.0.1:{s.port}", TOKEN, 10)).health().model, "fake-sfx")
            for token in (None, "wrong-token-0123456789"):
                with self.subTest(token=token), self.assertRaises(SfxFatalError) as caught:
                    SfxClient(ClientConfig(f"http://127.0.0.1:{s.port}", token, 10)).health()
                self.assertIn("401", str(caught.exception))


class MisbehavingServerTests(unittest.TestCase):
    def setUp(self):
        self.stub = StubServer()

    def tearDown(self):
        self.stub.close()

    def test_sends_the_token_and_exact_request(self):
        self.stub.client(TOKEN).render("a door", 2, 5, MODEL)
        method, path, headers, body = self.stub.requests[-1]
        self.assertEqual((method, path, body), ("POST", "/sfx", {"prompt": "a door", "durationSec": 2, "seed": 5}))
        self.assertEqual(headers["Authorization"], f"Bearer {TOKEN}")

    def test_never_follows_a_redirect(self):
        self.stub.sfx = lambda body: (307, {"Location": "https://evil.example/sfx"}, b"")
        with self.assertRaises(SfxFatalError) as caught:
            self.stub.client(TOKEN).render("a door", 2, 5, MODEL)
        self.assertIn("redirect", str(caught.exception))
        self.assertEqual(len(self.stub.requests), 1)

    def test_waits_out_busy_answers(self):
        answers = iter([503, 503, 200])

        def answer(body):
            if next(answers) == 503:
                return 503, {"Content-Type": "application/json"}, b'{"error":{"code":"busy","message":"later"}}'
            return 200, {"Content-Type": "audio/wav", "X-Model-Revision": "rev-1"}, noise(2)
        self.stub.sfx = answer
        waits = []
        client = SfxClient(ClientConfig(self.stub.url, None, 10), sleep=waits.append)
        client.render("a door", 2, 5, MODEL)
        self.assertEqual(waits, [2.0, 4.0])

    def test_stops_on_requests_the_server_refuses(self):
        for status in (400, 401, 404):
            self.stub.sfx = lambda body, s=status: (s, {"Content-Type": "application/json"}, b'{"error":{"code":"x","message":"no"}}')
            with self.subTest(status=status), self.assertRaises(SfxFatalError):
                self.stub.client().render("a door", 2, 5, MODEL)

    def test_a_failed_or_unusable_take_is_retryable(self):
        audio = {"Content-Type": "audio/wav", "X-Model-Revision": "rev-1"}
        cases = {
            "server error": lambda b: (500, {"Content-Type": "application/json"}, b'{"error":{"code":"internal","message":"x"}}'),
            "wrong length": lambda b: (200, audio, noise(b["durationSec"] + 0.2)),
            "wrong rate": lambda b: (200, audio, noise(b["durationSec"], 24000)),
            "not audio": lambda b: (200, {**audio, "Content-Type": "text/html"}, noise(b["durationSec"])),
            "broken audio": lambda b: (200, audio, noise(b["durationSec"])[:-10]),
            "no revision header": lambda b: (200, {"Content-Type": "audio/wav"}, noise(b["durationSec"])),
        }
        for label, answer in cases.items():
            self.stub.sfx = answer
            with self.subTest(label), self.assertRaises(SfxClientError):
                self.stub.client().render("a door", 2, 5, MODEL)

    def test_stops_when_the_model_changes_mid_run(self):
        self.stub.health["sfx"]["revision"] = "rev-2"
        self.stub.sfx = lambda body: (200, {"Content-Type": "audio/wav", "X-Model-Revision": "rev-2"}, noise(2))
        with self.assertRaises(SfxFatalError) as caught:
            self.stub.client().render("a door", 2, 5, MODEL)
        self.assertIn("model changed", str(caught.exception))

    def test_masks_the_token_in_server_messages(self):
        self.stub.sfx = lambda body: (500, {"Content-Type": "application/json"}, json.dumps({"error": {"code": "internal", "message": f"bad header Bearer {TOKEN}"}}).encode())
        with self.assertRaises(SfxClientError) as caught:
            self.stub.client(TOKEN).render("a door", 2, 5, MODEL)
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertIn("[token]", str(caught.exception))

    def test_refuses_an_oversized_answer(self):
        self.stub.sfx = lambda body: (200, {"Content-Type": "audio/wav", "X-Model-Revision": "rev-1"}, b"\0" * (20 * 1024 * 1024 + 1))
        with self.assertRaises(SfxClientError) as caught:
            self.stub.client().render("a door", 2, 5, MODEL)
        self.assertIn("larger than", str(caught.exception))


CUES = [
    {"id": "door_creak", "prompt": "A heavy door creaks open.", "durationSec": 2, "seed": 10, "loopable": False, "tags": ["door"]},
    {"id": "rain", "prompt": "Steady rain on a roof.", "durationSec": 3, "seed": 20, "loopable": True},
]


class GenerateTests(unittest.TestCase):
    def setUp(self):
        self.stub = StubServer()
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "takes"
        self.log = []

    def tearDown(self):
        self.stub.close()
        self.tmp.cleanup()

    def run_tool(self, cues=CUES, takes=2, only=None, token=TOKEN):
        return run(json.loads(json.dumps(cues)), self.out, self.stub.client(token), takes, only, log=self.log.append, sleep=no_sleep)

    def renders(self):
        return [r[3] for r in self.stub.requests if r[0] == "POST"]

    def test_renders_every_take_with_consecutive_seeds_and_records_them(self):
        self.assertEqual(self.run_tool(), 0)
        self.assertEqual(self.renders(), [
            {"prompt": "A heavy door creaks open.", "durationSec": 2, "seed": 10},
            {"prompt": "A heavy door creaks open.", "durationSec": 2, "seed": 11},
            {"prompt": "Steady rain on a roof.", "durationSec": 3, "seed": 20},
            {"prompt": "Steady rain on a roof.", "durationSec": 3, "seed": 21},
        ])
        state = json.loads((self.out / "takes.json").read_text())
        self.assertEqual(state["model"], MODEL.identity())
        take = state["takes"]["door_creak"]["2"]
        self.assertEqual({k: take[k] for k in ("seed", "file", "sampleRate", "frames")}, {"seed": 11, "file": "take-2.wav", "sampleRate": 48000, "frames": 96000})
        self.assertTrue((self.out / "door_creak" / "take-2.wav").is_file())
        self.assertIn("rain/take-1.wav", (self.out / "index.html").read_text())
        self.assertEqual([p.name for p in self.out.rglob("*.tmp")], [])

    def test_resumes_without_re_rendering_and_re_renders_only_what_changed(self):
        self.run_tool()
        self.run_tool()
        self.assertEqual(len(self.renders()), 4)  # second run: nothing to do
        changed = [dict(CUES[0], prompt="A heavier door creaks open."), CUES[1]]
        self.run_tool(changed)
        self.assertEqual([r["prompt"] for r in self.renders()[4:]], ["A heavier door creaks open."] * 2)
        (self.out / "rain" / "take-1.wav").write_bytes(b"tampered")
        self.run_tool(changed)
        self.assertEqual([(r["prompt"], r["seed"]) for r in self.renders()[6:]], [("Steady rain on a roof.", 20)])
        self.run_tool([changed[0], dict(CUES[1], seed=30)])  # a new seed is a new take
        self.assertEqual([r["seed"] for r in self.renders()[7:]], [30, 31])

    def test_more_takes_later_renders_only_the_new_ones(self):
        self.run_tool(takes=1)
        self.run_tool(takes=3)
        self.assertEqual([r["seed"] for r in self.renders()], [10, 20, 11, 12, 21, 22])

    def test_refuses_a_folder_made_with_another_model(self):
        self.run_tool()
        self.stub.health["sfx"]["revision"] = "rev-2"
        self.assertEqual(self.run_tool(), 2)
        self.assertIn("Use another --out folder", self.log[-1])
        self.assertEqual(len(self.renders()), 4)

    def test_a_failing_take_is_retried_then_skipped_and_the_rest_still_render(self):
        def answer(body):
            if body["seed"] == 20:
                return 500, {"Content-Type": "application/json"}, b'{"error":{"code":"internal","message":"boom"}}'
            return 200, {"Content-Type": "audio/wav", "X-Model-Revision": "rev-1"}, noise(body["durationSec"])
        self.stub.sfx = answer
        self.assertEqual(self.run_tool(), 1)
        self.assertEqual([r["seed"] for r in self.renders()], [10, 11, 20, 20, 20, 21])
        self.assertNotIn("1", json.loads((self.out / "takes.json").read_text())["takes"]["rain"])
        self.stub.sfx = lambda body: (200, {"Content-Type": "audio/wav", "X-Model-Revision": "rev-1"}, noise(body["durationSec"]))
        self.assertEqual(self.run_tool(), 0)  # rerun fills the gap only
        self.assertEqual([r["seed"] for r in self.renders()[6:]], [20])
        self.assertFalse(any(TOKEN in line for line in self.log))

    def test_stops_on_a_refused_request_and_keeps_what_was_done(self):
        self.stub.sfx = lambda body: (401, {"Content-Type": "application/json"}, b'{"error":{"code":"unauthorized","message":"no"}}') if body["seed"] == 11 else (200, {"Content-Type": "audio/wav", "X-Model-Revision": "rev-1"}, noise(body["durationSec"]))
        self.assertEqual(self.run_tool(), 2)
        self.assertEqual(list(json.loads((self.out / "takes.json").read_text())["takes"]["door_creak"]), ["1"])

    def test_only(self):
        self.assertEqual(self.run_tool(only={"rain"}), 0)
        self.assertEqual({r["prompt"] for r in self.renders()}, {"Steady rain on a roof."})
        self.assertEqual(self.run_tool(only={"nope"}), 2)

    def test_listening_page_escapes_everything(self):
        cue = dict(CUES[0], prompt='<script>alert("x")</script>')
        page = listening_page([cue], {"model": {"model": "<b>m</b>", "revision": "r", "license": "x"}, "takes": {}})
        self.assertNotIn("<script>", page)
        self.assertNotIn("<b>m</b>", page)


class PromptsTests(unittest.TestCase):
    def check(self, cues, takes=3):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prompts.json"
            path.write_text(json.dumps({"version": 1, "cues": cues}))
            return load_prompts(path, takes)

    def test_the_committed_prompt_list_is_valid(self):
        cues = load_prompts(PROMPTS, 3)
        self.assertGreaterEqual(len(cues), 30)
        self.assertTrue(any(c["loopable"] for c in cues) and any(not c["loopable"] for c in cues))

    def test_refuses_bad_cues(self):
        good = dict(CUES[0])
        cases = [
            ([good, dict(good)], "twice"),
            ([dict(good, id="Door Creak")], "id must be"),
            ([dict(good, prompt=" ")], "prompt"),
            ([dict(good, prompt="x" * 501)], "prompt"),
            ([dict(good, durationSec=31)], "durationSec"),
            ([dict(good, durationSec=True)], "durationSec"),
            ([dict(good, seed=-1)], "seed"),
            ([dict(good, seed=2_147_483_646)], "seed"),  # seed + take 3 would overflow
            ([{k: v for k, v in good.items() if k != "loopable"}], "loopable"),
            ([dict(good, tags=["Not OK"])], "tags"),
            ([dict(good, gain=3)], "unknown fields"),
            ([], "at least one cue"),
        ]
        for cues, fragment in cases:
            with self.subTest(fragment), self.assertRaises(PromptsError) as caught:
                self.check(cues)
            self.assertIn(fragment, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
