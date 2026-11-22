"""A model-free backend for tests and for developing the TypeScript client.

It returns tones, never speech. Never use it to produce audio that will be heard.
"""

import math
import time
import zlib
from typing import Optional

from ..wav import encode_wav
from .base import Backend, SfxRequest, TtsRequest, VoiceDesignRequest

TTS_RATE = 24_000
SFX_RATE = 48_000
MS_PER_WORD = 350


class FakeBackend(Backend):
    name = "fake"

    def __init__(self, delay_ms: int = 0):
        self._delay = delay_ms / 1000

    def tts_info(self) -> Optional[dict]:
        return {"model": "fake-tts", "revision": "fake-1", "sampleRate": TTS_RATE, "ready": True}

    def sfx_info(self) -> Optional[dict]:
        return {"model": "fake-sfx", "revision": "fake-1", "license": "CC0-1.0", "sampleRate": SFX_RATE, "ready": True}

    def design_info(self) -> Optional[dict]:
        return {"model": "fake-voice-design", "revision": "fake-design-1", "sampleRate": TTS_RATE, "ready": True}

    def render_design(self, request: VoiceDesignRequest) -> bytes:
        if self._delay:
            time.sleep(self._delay)
        words = max(1, len(request.text.split()))
        frames = words * MS_PER_WORD * TTS_RATE // 1000
        freq = 110 + zlib.crc32(request.instruct.encode("utf-8") + b"\0" + str(request.seed).encode("ascii")) % 220
        fade = TTS_RATE // 100
        samples = [
            round(math.sin(2 * math.pi * freq * i / TTS_RATE) * 13_000 * max(0.0, min(1.0, i / fade, (frames - 1 - i) / fade)))
            for i in range(frames)
        ]
        if not any(samples):
            samples[frames // 2] = 1
        return encode_wav(samples, TTS_RATE)

    def render_tts(self, request: TtsRequest) -> bytes:
        if self._delay:
            time.sleep(self._delay)
        words = max(1, len(request.text.split()))
        frames = words * MS_PER_WORD * TTS_RATE // 1000
        # Pitch depends on the reference clip and its text, so a different reference sounds different.
        freq = 110 + zlib.crc32(request.reference_wav + request.reference_text.encode("utf-8")) % 220
        fade = TTS_RATE // 100
        samples = [
            round(math.sin(2 * math.pi * freq * i / TTS_RATE) * 13_000 * max(0.0, min(1.0, i / fade, (frames - 1 - i) / fade)))
            for i in range(frames)
        ]
        if not any(samples):
            samples[frames // 2] = 1
        return encode_wav(samples, TTS_RATE)

    def render_sfx(self, request: SfxRequest) -> bytes:
        if self._delay:
            time.sleep(self._delay)
        frames = int(request.duration_sec * SFX_RATE)
        state = (request.seed or 1) & 0x7FFFFFFF or 1
        samples = []
        for _ in range(frames):
            state = (state * 1_103_515_245 + 12_345) & 0x7FFFFFFF  # small deterministic noise generator
            samples.append((state >> 16) % 8_000 - 4_000)
        return encode_wav(samples, SFX_RATE)
