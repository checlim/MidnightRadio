"""The qwen-mlx backend against the real Qwen3-TTS model.

Runs only where the model and mlx-audio are available:
    MR_QWEN_BASE=<Base snapshot dir> [MR_QWEN_DESIGN=<VoiceDesign snapshot dir>] \
    .venv/bin/python -m unittest tests.test_qwen_mlx
Everywhere else (and in CI) it is skipped. The parts that need no model always run.
"""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

from local_audio.backends import BackendUnavailable, create_backend
from local_audio.backends.qwen_mlx import describe_snapshot, file_sha256
from tests.helpers import serving, wav_info, write_catalogue

BASE = os.environ.get("MR_QWEN_BASE")
DESIGN = os.environ.get("MR_QWEN_DESIGN")
HAVE_MLX = importlib.util.find_spec("mlx_audio") is not None
REF_TEXT = "Good evening. The night is cold, the road is long, and the old house waits at the end of it."
SPIKE = Path(__file__).resolve().parent.parent / "spike-output"


class WithoutAModel(unittest.TestCase):
    def test_describes_a_hugging_face_snapshot_and_any_other_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            snap = Path(tmp) / "models--mlx-community--Qwen3-TTS-12Hz-1.7B-Base-bf16" / "snapshots" / ("a" * 40)
            snap.mkdir(parents=True)
            self.assertEqual(describe_snapshot(snap), ("Qwen3-TTS-12Hz-1.7B-Base-bf16", "a" * 40))
            other = Path(tmp) / "my-model"
            other.mkdir()
            self.assertEqual(describe_snapshot(other), ("my-model", "local"))

    def test_hashes_a_file_in_chunks(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "w.bin"
            f.write_bytes(b"x" * 100_000)
            import hashlib

            self.assertEqual(file_sha256(f, chunk=4096), hashlib.sha256(b"x" * 100_000).hexdigest())

    def test_refuses_a_directory_without_weights_or_with_a_non_base_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            with self.assertRaisesRegex(BackendUnavailable, "no model.safetensors"):
                create_backend("qwen-mlx", tts_model=d)
            (d / "model.safetensors").write_bytes(b"not really weights")
            (d / "config.json").write_text(json.dumps({"tts_model_type": "voice_design"}))
            with self.assertRaisesRegex(BackendUnavailable, "needs a Qwen3-TTS Base model, not 'voice_design'"):
                create_backend("qwen-mlx", tts_model=d)
            (d / "config.json").write_text("{not json")
            with self.assertRaisesRegex(BackendUnavailable, "cannot read"):
                create_backend("qwen-mlx", tts_model=d)


@unittest.skipUnless(BASE and HAVE_MLX and (SPIKE / "ref-nobleman.wav").exists(), "needs MR_QWEN_BASE, mlx-audio and the spike's reference clips")
class WithTheRealModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = create_backend("qwen-mlx", tts_model=Path(BASE))

    @classmethod
    def tearDownClass(cls):
        cls.backend.close()

    def test_reports_the_pinned_revision_and_weights_hash(self):
        info = self.backend.tts_info()
        self.assertEqual(info["sampleRate"], 24_000)
        self.assertRegex(info["revision"], r"^[0-9a-f]{40}$")
        self.assertRegex(info["weightsSha256"], r"^[0-9a-f]{64}$")
        self.assertIsNone(self.backend.sfx_info())

    def test_clones_a_voice_over_http_repeatably_and_distinctly(self):
        def use_spike_clips(entries):
            import hashlib

            for e in entries:
                clip = (SPIKE / f"ref-{e['id']}.wav").read_bytes()
                self._dir_clips[e["id"]] = clip
                e["clip"].update(sha256=hashlib.sha256(clip).hexdigest(), transcript=REF_TEXT)

        self._dir_clips = {}
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            catalogue = write_catalogue(base, voices=("nobleman", "young-man"), mutate=use_spike_clips)
            for vid, clip in self._dir_clips.items():
                (base / "clips" / f"{vid}.wav").write_bytes(clip)
            with serving(backend=self.backend, catalogue_path=catalogue) as s:
                status, health = s.json("GET", "/health")
                self.assertEqual((status, health["backend"], health["tts"]["weightsSha256"]), (200, "qwen-mlx", self.backend.tts_info()["weightsSha256"]))
                line = {"voiceId": "nobleman", "text": "Welcome to my house.", "seed": 7}
                status, headers, first = s.request("POST", "/tts", line)
                self.assertEqual(status, 200)
                self.assertEqual(headers["x-model-revision"], self.backend.tts_info()["revision"])
                info = wav_info(first)
                self.assertEqual((info["rate"], info["channels"], info["width"]), (24_000, 1, 2))
                self.assertGreater(info["frames"], 24_000 // 2)  # at least half a second of speech
                self.assertEqual(s.request("POST", "/tts", line)[2], first)  # same seed, same audio
                self.assertNotEqual(s.request("POST", "/tts", {**line, "seed": 8})[2], first)
                self.assertNotEqual(s.request("POST", "/tts", {**line, "voiceId": "young-man"})[2], first)
                self.assertEqual(s.request("POST", "/tts", {**line, "delivery": "whisper"})[0], 200)  # accepted, not yet used

    def test_refuses_sound_effects(self):
        from local_audio.backends import SfxRequest
        from local_audio.backends.base import BackendError

        with self.assertRaises(BackendError):
            self.backend.render_sfx(SfxRequest("rain", 1.0, None))


@unittest.skipUnless(DESIGN, "needs MR_QWEN_DESIGN")
class RefusesTheDesignModel(unittest.TestCase):
    def test_the_voice_design_model_cannot_be_used_for_rendering(self):
        with self.assertRaisesRegex(BackendUnavailable, "needs a Qwen3-TTS Base model"):
            create_backend("qwen-mlx", tts_model=Path(DESIGN))


if __name__ == "__main__":
    unittest.main()
