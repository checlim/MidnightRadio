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

from local_audio.config import ConfigError, parse_config
from local_audio.wav import encode_wav
from tests.helpers import wav_info

ROOT = Path(__file__).resolve().parent.parent


class ConfigTests(unittest.TestCase):
    base = ["--backend", "fake"]

    def setUp(self):
        # argparse prints its usage text to stderr before failing; keep the test output clean.
        quiet = contextlib.redirect_stderr(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def test_defaults(self):
        c = parse_config(self.base, {})
        self.assertEqual((c.host, c.port, c.backend, c.token), ("127.0.0.1", 8765, "fake", None))

    def test_the_backend_must_be_chosen_explicitly(self):
        with self.assertRaises(ConfigError):
            parse_config([], {})

    def test_the_catalogue_option_is_gone(self):
        with self.assertRaises(ConfigError):
            parse_config(["--catalogue", "c.json", "--backend", "fake"], {})

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
        proc = self.run_main(["--backend", "fake", "--port", "0"])
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

        for attempt in range(20):
            proc = self.run_main(["--backend", "fake", "--port", "0"])
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
            cases = [
                (["--backend", "qwen-mlx"], "needs --tts-model"),
                (["--backend", "qwen-mlx", "--tts-model", str(Path(tmp))], "no model.safetensors"),
                (["--backend", "nonsense"], "unknown backend"),
                (["--backend", "fake", "--host", "0.0.0.0"], "only listens on 127.0.0.1"),
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
        proc = self.run_main(["--backend", "fake", "--port", "0"], LOCAL_AUDIO_TOKEN=token)
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
