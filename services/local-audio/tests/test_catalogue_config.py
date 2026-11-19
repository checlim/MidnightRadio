import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from local_audio.catalogue import CatalogueError, load_catalogue
from local_audio.config import ConfigError, parse_config
from local_audio.wav import encode_wav
from tests.helpers import TRANSCRIPT, VOICES, sha256, wav_info, write_catalogue

ROOT = Path(__file__).resolve().parent.parent


def load_with(mutate=None, **kw):
    with tempfile.TemporaryDirectory() as tmp:
        path = write_catalogue(Path(tmp), mutate=mutate, **kw)
        return load_catalogue(path)


def fails_with(test: unittest.TestCase, fragment: str, mutate):
    with test.assertRaises(CatalogueError) as caught:
        load_with(mutate)
    test.assertIn(fragment, str(caught.exception))


class CatalogueTests(unittest.TestCase):
    def test_loads_every_voice_with_its_verified_clip(self):
        with tempfile.TemporaryDirectory() as tmp:
            clips = load_catalogue(write_catalogue(Path(tmp)))
            self.assertEqual(sorted(clips), sorted(VOICES))
            clip = clips["stub-f1"]
            self.assertTrue(clip.path.is_file())
            self.assertEqual((clip.sha256, clip.transcript), (sha256(clip.path.read_bytes()), TRANSCRIPT))
            self.assertEqual(clip.transcript_sha256, sha256(TRANSCRIPT.encode("utf-8")))

    def test_refuses_a_clip_that_does_not_match_its_hash(self):
        def tamper(entries):
            entries[0]["clip"]["sha256"] = "0" * 64

        fails_with(self, "does not match its recorded hash", tamper)

    def test_refuses_a_missing_clip_and_a_voice_without_one(self):
        fails_with(self, "clip file is missing", lambda e: e[0]["clip"].update(file="clips/nope.wav"))
        fails_with(self, "has no reference clip", lambda e: e[0].pop("clip"))

    def test_refuses_paths_that_leave_the_catalogue_directory(self):
        for file in ["../outside.wav", "/etc/hosts.wav", "clips/../../x.wav", "clips/./x.wav", "clips//x.wav", "clips\\x.wav", "clips/x.mp3", ""]:
            with self.subTest(file=file):
                fails_with(self, "invalid clip path", lambda e, f=file: e[0]["clip"].update(file=f))

    def test_refuses_a_symlink_that_points_outside(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as elsewhere:
            base = Path(tmp)
            outside = Path(elsewhere) / "evil.wav"
            outside.write_bytes(encode_wav([1, 2, 3], 24000))
            path = write_catalogue(base)
            (base / "clips" / "stub-f1.wav").unlink()
            (base / "clips" / "stub-f1.wav").symlink_to(outside)
            with self.assertRaises(CatalogueError) as caught:
                load_catalogue(path)
        self.assertIn("outside the catalogue directory", str(caught.exception))

    def test_refuses_duplicates_bad_hashes_blank_transcripts_and_bad_ids(self):
        fails_with(self, "appears twice", lambda e: e.append(dict(e[0])))
        fails_with(self, "invalid clip hash", lambda e: e[0]["clip"].update(sha256="XYZ"))
        fails_with(self, "invalid clip transcript", lambda e: e[0]["clip"].update(transcript="   "))
        fails_with(self, "invalid clip transcript", lambda e: e[0]["clip"].update(transcript="x" * 501))
        fails_with(self, "missing or invalid id", lambda e: e[0].update(id="has space"))

    def test_refuses_unreadable_or_empty_catalogues_without_echoing_their_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "bad.json").write_text("{not json: super-secret-value", encoding="utf-8")
            with self.assertRaises(CatalogueError) as caught:
                load_catalogue(base / "bad.json")
            self.assertNotIn("super-secret-value", str(caught.exception))
            (base / "empty.json").write_text(json.dumps({"voices": []}), encoding="utf-8")
            with self.assertRaises(CatalogueError):
                load_catalogue(base / "empty.json")
            with self.assertRaises(CatalogueError) as missing:
                load_catalogue(base / "absent.json")
            self.assertIn("not found", str(missing.exception))


class ConfigTests(unittest.TestCase):
    base = ["--catalogue", "c.json", "--backend", "fake"]

    def setUp(self):
        # argparse prints its usage text to stderr before failing; keep the test output clean.
        quiet = contextlib.redirect_stderr(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def test_defaults(self):
        c = parse_config(self.base, {})
        self.assertEqual((c.host, c.port, c.backend, c.token), ("127.0.0.1", 8765, "fake", None))

    def test_the_backend_and_catalogue_must_be_chosen_explicitly(self):
        for argv in (["--backend", "fake"], ["--catalogue", "c.json"]):
            with self.subTest(argv=argv), self.assertRaises(ConfigError):
                parse_config(argv, {})

    def test_only_loopback_hosts_are_accepted(self):
        self.assertEqual(parse_config(self.base + ["--host", "localhost"], {}).host, "127.0.0.1")
        for host in ("0.0.0.0", "192.168.1.5", "example.com", "::"):
            with self.subTest(host=host), self.assertRaises(ConfigError) as caught:
                parse_config(self.base + ["--host", host], {})
            self.assertIn("only listens on 127.0.0.1", str(caught.exception))

    def test_port_and_delays_are_checked(self):
        for extra in (["--port", "70000"], ["--port", "-1"], ["--fake-delay-ms", "-5"], ["--queue-timeout-s", "0"]):
            with self.subTest(extra=extra), self.assertRaises(ConfigError):
                parse_config(self.base + extra, {})

    def test_the_token_comes_from_the_environment_and_must_be_long_enough(self):
        self.assertEqual(parse_config(self.base, {"LOCAL_AUDIO_TOKEN": "x" * 16}).token, "x" * 16)
        self.assertIsNone(parse_config(self.base, {"LOCAL_AUDIO_TOKEN": "  "}).token)
        with self.assertRaises(ConfigError) as caught:
            parse_config(self.base, {"LOCAL_AUDIO_TOKEN": "short-secret"})
        self.assertNotIn("short-secret", str(caught.exception))
        with self.assertRaises(ConfigError):
            parse_config(self.base + ["--token", "x" * 20], {})  # there is deliberately no command-line token


class WavTests(unittest.TestCase):
    def test_writes_a_canonical_mono_16bit_file_that_round_trips(self):
        data = encode_wav([0, 1000, -1000, 32767, -32768], 24000)
        self.assertEqual(len(data), 44 + 10)
        self.assertEqual(wav_info(data), {"rate": 24000, "channels": 1, "width": 2, "frames": 5})

    def test_refuses_samples_that_do_not_fit_in_16_bits(self):
        with self.assertRaises(OverflowError):
            encode_wav([40000], 24000)


class ProcessTests(unittest.TestCase):
    def run_main(self, args, **kw):
        return subprocess.Popen([sys.executable, "-m", "local_audio", *args], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**os.environ, **kw})

    def test_starts_announces_its_address_and_stops_cleanly_on_sigterm(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalogue = write_catalogue(Path(tmp))
            proc = self.run_main(["--catalogue", str(catalogue), "--backend", "fake", "--port", "0"])
            try:
                line = json.loads(proc.stdout.readline())
                self.assertRegex(line["listening"], r"^http://127\.0\.0\.1:\d+$")
                proc.terminate()
                self.assertEqual(proc.wait(timeout=15), 0)
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.stdout.close()
                proc.stderr.close()

    def test_always_stops_on_sigterm_whenever_it_arrives(self):
        # Regression: a SIGTERM handler that took a lock (threading.Event.set) could deadlock with
        # the main thread waiting on that same lock, so about one run in thirteen ignored SIGTERM.
        import random

        with tempfile.TemporaryDirectory() as tmp:
            catalogue = write_catalogue(Path(tmp))
            for attempt in range(20):
                proc = self.run_main(["--catalogue", str(catalogue), "--backend", "fake", "--port", "0"])
                try:
                    proc.stdout.readline()
                    time.sleep(random.uniform(0, 0.3))
                    proc.terminate()
                    with self.subTest(attempt=attempt):
                        self.assertEqual(proc.wait(timeout=10), 0)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait()
                    proc.stdout.close()
                    proc.stderr.close()

    def test_exits_with_a_clear_message_and_no_traceback_when_it_cannot_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = write_catalogue(Path(tmp))
            cases = [
                (["--catalogue", str(good), "--backend", "qwen-mlx"], "not implemented yet"),
                (["--catalogue", str(Path(tmp) / "missing.json"), "--backend", "fake"], "not found"),
                (["--catalogue", str(good), "--backend", "fake", "--host", "0.0.0.0"], "only listens on 127.0.0.1"),
            ]
            for args, message in cases:
                with self.subTest(message=message):
                    proc = self.run_main(args)
                    _, err = proc.communicate(timeout=30)
                    self.assertEqual(proc.returncode, 2)
                    self.assertIn(message, err)
                    self.assertNotIn("Traceback", err)

    def test_a_token_in_the_environment_is_never_printed(self):
        token = "env-token-0123456789abcdef"
        with tempfile.TemporaryDirectory() as tmp:
            catalogue = write_catalogue(Path(tmp))
            proc = self.run_main(["--catalogue", str(catalogue), "--backend", "fake", "--port", "0"], LOCAL_AUDIO_TOKEN=token)
            try:
                out = proc.stdout.readline()
                proc.terminate()
                proc.wait(timeout=15)
                err = proc.stderr.read()
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.stdout.close()
                proc.stderr.close()
        self.assertNotIn(token, out + err)


if __name__ == "__main__":
    unittest.main()
