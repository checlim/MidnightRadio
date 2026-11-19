"""Loads the pinned voice catalogue and verifies every reference clip against its recorded hash.

The catalogue file is the same `catalogue.json` the TypeScript side reads. The service refuses to
start if a clip is missing, escapes the catalogue directory, or does not match its hash, so audio
can never be cloned from a clip the catalogue does not describe.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

MAX_CLIP_BYTES = 10 * 1024 * 1024
_VOICE_ID = re.compile(r"^[\w.:-]{1,100}$")
_CLIP_FILE = re.compile(r"^\w[\w./-]*\.wav$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class CatalogueError(Exception):
    """The catalogue cannot be used. The message names the voice and the problem."""


@dataclass(frozen=True)
class VoiceClip:
    voice_id: str
    path: Path
    sha256: str
    transcript: str
    transcript_sha256: str


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_catalogue(catalogue_path: Path) -> dict[str, VoiceClip]:
    try:
        raw = json.loads(catalogue_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise CatalogueError(f"catalogue not found: {catalogue_path}") from None
    except (OSError, ValueError) as err:
        raise CatalogueError(f"catalogue unreadable: {type(err).__name__}") from None
    if not isinstance(raw, dict) or not isinstance(raw.get("voices"), list) or not raw["voices"]:
        raise CatalogueError("catalogue needs a non-empty 'voices' list")

    base = catalogue_path.parent.resolve()
    clips: dict[str, VoiceClip] = {}
    for entry in raw["voices"]:
        voice_id = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(voice_id, str) or not _VOICE_ID.match(voice_id):
            raise CatalogueError("a voice has a missing or invalid id")
        if voice_id in clips:
            raise CatalogueError(f"voice '{voice_id}' appears twice")
        clip = entry.get("clip")
        if not isinstance(clip, dict):
            raise CatalogueError(f"voice '{voice_id}' has no reference clip")

        file = clip.get("file")
        sha = clip.get("sha256")
        transcript = clip.get("transcript")
        if not isinstance(file, str) or not _CLIP_FILE.match(file) or any(s in ("", ".", "..") for s in file.split("/")):
            raise CatalogueError(f"voice '{voice_id}' has an invalid clip path")
        if not isinstance(sha, str) or not _SHA256.match(sha):
            raise CatalogueError(f"voice '{voice_id}' has an invalid clip hash")
        if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 500:
            raise CatalogueError(f"voice '{voice_id}' has an invalid clip transcript")

        path = (base / file).resolve()
        if not path.is_relative_to(base):  # also catches symlinks that point outside
            raise CatalogueError(f"voice '{voice_id}' clip is outside the catalogue directory")
        if not path.is_file():
            raise CatalogueError(f"voice '{voice_id}' clip file is missing")
        if path.stat().st_size > MAX_CLIP_BYTES:
            raise CatalogueError(f"voice '{voice_id}' clip is larger than {MAX_CLIP_BYTES // (1024 * 1024)} MB")
        if _sha256(path.read_bytes()) != sha:
            raise CatalogueError(f"voice '{voice_id}' clip does not match its recorded hash")

        clips[voice_id] = VoiceClip(voice_id, path, sha, transcript, _sha256(transcript.encode("utf-8")))
    return clips
