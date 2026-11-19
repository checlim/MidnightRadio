"""Build assets/voices/catalogue.json from the chosen takes.

    python tools/assemble_catalogue.py [--candidates DIR]

Reads assets/voices/voices.json (the designs) and assets/voices/picks.json ({"voice-id": take}),
copies each chosen take to assets/voices/clips/<id>.wav, and writes catalogue.json in the format
both the app and this service read. Refuses to write anything unless every voice has a valid pick.
Standard library only.
"""

import argparse
import hashlib
import json
import shutil
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
VOICES_DIR = ROOT / "assets/voices"

# The models the catalogue is pinned to (see services/local-audio/README.md).
MODELS = [
    {"role": "voice-design", "name": "Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16", "revision": "7d3824abff87e49756bb0f83fb5411de75d160c4", "weightsSha256": "96ae28bec2205ec0b5e0c750bea2b8a5deac4f14d33a8a25a5f753299486b70e"},
    {"role": "voice-clone", "name": "Qwen3-TTS-12Hz-1.7B-Base-bf16", "revision": "a6eb4f68e4b056f1215157bb696209bc82a6db48", "weightsSha256": "81fb76175ff74e69be25fef2cc3e54f016df3034f1514c8e1c89da06a3510cff"},
]
CATALOGUE = {"id": "midnight-radio-qwen3-voices", "provider": "qwen3-tts", "model": "Qwen3-TTS-12Hz-1.7B-Base-bf16", "version": "1", "seed": "midnight-radio-voices-1"}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_wav(path: Path) -> None:
    with wave.open(str(path)) as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (24_000, 1, 2) or w.getnframes() == 0:
            raise SystemExit(f"{path} is not 24 kHz mono 16-bit audio")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", type=Path, default=Path(__file__).resolve().parent.parent / "catalogue-candidates")
    ap.add_argument("--voices-dir", type=Path, default=VOICES_DIR)
    args = ap.parse_args()

    spec = json.loads((args.voices_dir / "voices.json").read_text(encoding="utf-8"))
    picks_path = args.voices_dir / "picks.json"
    picks = json.loads(picks_path.read_text(encoding="utf-8")) if picks_path.exists() else {}
    takes = json.loads((args.candidates / "takes.json").read_text(encoding="utf-8"))
    ids = [v["id"] for v in spec["voices"]]

    problems = []
    unknown = sorted(set(picks) - set(ids))
    if unknown:
        problems.append(f"picks for voices that are not in voices.json: {', '.join(unknown)}")
    missing = [i for i in ids if picks.get(i) is None]  # absent, or null in picks.json: not chosen yet
    if missing:
        problems.append(f"{len(missing)} voices have no pick yet: {', '.join(missing)}")
    for vid, take in picks.items():
        if vid in ids and take is not None and (not isinstance(take, int) or isinstance(take, bool) or str(take) not in takes.get(vid, {})):
            problems.append(f"{vid}: take {take!r} was not rendered")
    if problems:
        raise SystemExit("not written:\n  " + "\n  ".join(problems))

    clips_dir = args.voices_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    voices = []
    for v in spec["voices"]:
        take = picks[v["id"]]
        source = args.candidates / v["id"] / f"take-{take}.wav"
        if sha256(source) != takes[v["id"]][str(take)]["sha256"]:
            raise SystemExit(f"{source} has changed since it was rendered")
        check_wav(source)
        target = clips_dir / f"{v['id']}.wav"
        shutil.copyfile(source, target)
        voices.append({
            "id": v["id"],
            "name": v["name"],
            "gender": v["gender"],
            "ageBands": v["ageBands"],
            "description": v["description"],
            "clip": {"file": f"clips/{v['id']}.wav", "sha256": sha256(target), "transcript": spec["referenceText"]},
        })
    # Clips from voices no longer in the spec are removed, so the folder matches the catalogue.
    for stale in clips_dir.glob("*.wav"):
        if stale.stem not in picks:
            stale.unlink()

    catalogue = {**CATALOGUE, "reserved": spec["reserved"], "models": MODELS, "voices": voices}
    (args.voices_dir / "catalogue.json").write_text(json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    seeds = {v["id"]: takes[v["id"]][str(picks[v["id"]])]["seed"] for v in spec["voices"]}
    print(f"wrote {len(voices)} voices to {args.voices_dir / 'catalogue.json'}; design seeds: {json.dumps(seeds)}")


if __name__ == "__main__":
    sys.exit(main())
