"""Minimal PCM WAV writer: mono, 16-bit, little-endian, with a canonical 44-byte header."""

import array
import sys
from typing import Iterable


def encode_wav(samples: Iterable[int], sample_rate: int) -> bytes:
    data = array.array("h", samples)
    if sys.byteorder == "big":
        data.byteswap()
    pcm = data.tobytes()
    le = lambda value, size: value.to_bytes(size, "little")  # noqa: E731
    header = (
        b"RIFF" + le(36 + len(pcm), 4) + b"WAVE"
        + b"fmt " + le(16, 4) + le(1, 2) + le(1, 2) + le(sample_rate, 4) + le(sample_rate * 2, 4) + le(2, 2) + le(16, 2)
        + b"data" + le(len(pcm), 4)
    )
    return header + pcm
