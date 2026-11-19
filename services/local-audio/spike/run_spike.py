"""Task 5.1 spike: measure Qwen3-TTS on this machine and produce clips to judge by ear.

    .venv/bin/python spike/run_spike.py [--out spike-output] [--quick]

Loads one model at a time (16 GB machines). Writes WAVs plus results.json and LISTEN.md into the
output folder, which is git-ignored. Nothing here is used by the app; it answers four questions:

1. Does the output match the cache format (24 kHz mono), and how fast is rendering here?
2. Does fixing the random seed make a render repeatable (the cache key assumes it does)?
3. Do designed voices sound right for 1940s radio, and distinct from each other? (your ears)
4. Delivery hints: (a) clone and ignore the hint, (b) clone from a per-delivery reference clip,
   (c) VoiceDesign per line with the hint in the description. Which keeps the voice recognisable? (your ears)
"""

import argparse
import gc
import hashlib
import json
import platform
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model

BASE = ("mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16", "a6eb4f68e4b056f1215157bb696209bc82a6db48")
DESIGN = ("mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16", "7d3824abff87e49756bb0f83fb5411de75d160c4")
SEED = 1940

# The fixed sentence every reference clip reads (it becomes the clip transcript).
REFERENCE_TEXT = "Good evening. The night is cold, the road is long, and the old house waits at the end of it."

# Archetypes only: no real person, performer or recording is named or imitated.
VOICES = {
    "announcer": "A deep, warm, booming male radio announcer in his forties, measured and theatrical, crisp diction, studio microphone, mid-twentieth-century broadcast style.",
    "narrator": "A calm, clear female storyteller in her thirties with a low, even, slightly husky tone, unhurried pacing, intimate and close to the microphone.",
    "nobleman": "An elderly European nobleman with a slow, courteous, cultured baritone, faintly accented English, quiet menace beneath perfect politeness.",
    "young-man": "A young English solicitor in his late twenties, educated and polite, slightly nervous, clear tenor voice, earnest.",
}

# Real lines from the bundled Dracula Chapter II excerpt (verbatim).
LINES = {
    "nobleman": "I am Dracula; and I bid you welcome, Mr. Harker, to my house. Come in; the night air is chill, and you must need to eat and rest.",
    "nobleman-short": "Listen to them—the children of the night. What music they make!",
    "young-man": "Count Dracula?",
}

DELIVERY_HINTS = {"whisper": "whispering, hushed and breathy", "sinister": "slow, low and sinister"}


def snapshot(model: tuple) -> Path:
    """The verified local snapshot of a pinned model: never downloads, never another revision."""
    repo, revision = model
    path = Path.home() / ".cache/huggingface/hub" / f"models--{repo.replace('/', '--')}" / "snapshots" / revision
    if not (path / "model.safetensors").exists():
        raise SystemExit(f"{repo}@{revision[:7]} is not downloaded")
    return path


def to_numpy(audio) -> np.ndarray:
    return np.asarray(audio, dtype=np.float32).reshape(-1)


def render(model, text: str, seed: int = SEED, **kw) -> dict:
    mx.random.seed(seed)
    started = time.perf_counter()
    results = list(model.generate(text=text, lang_code="english", **kw))
    elapsed = time.perf_counter() - started
    audio = np.concatenate([to_numpy(r.audio) for r in results])
    rate = results[0].sample_rate
    return {"audio": audio, "rate": rate, "seconds": elapsed, "duration": len(audio) / rate, "peak_gb": max(r.peak_memory_usage for r in results)}


def save(out: Path, name: str, r: dict) -> dict:
    path = out / f"{name}.wav"
    sf.write(path, r["audio"], r["rate"], subtype="PCM_16")
    pcm = (np.clip(r["audio"], -1, 1) * 32767).astype("<i2").tobytes()
    return {
        "file": path.name,
        "sampleRate": r["rate"],
        "durationSec": round(r["duration"], 2),
        "renderSec": round(r["seconds"], 2),
        "realTimeFactor": round(r["seconds"] / r["duration"], 2) if r["duration"] else None,
        "msPerChar": None,
        "peakMemoryGb": round(r["peak_gb"], 2),
        "pcmSha256": hashlib.sha256(pcm).hexdigest(),
    }


def unload(model) -> None:
    del model
    gc.collect()
    mx.clear_cache()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "spike-output")
    ap.add_argument("--quick", action="store_true", help="two voices and no delivery comparison")
    args = ap.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    voices = dict(list(VOICES.items())[:2] if args.quick else VOICES.items())
    report = {"machine": f"{platform.machine()} {platform.mac_ver()[0]}", "mlx": mx.__version__, "seed": SEED, "models": {"design": DESIGN, "base": BASE}, "renders": {}}

    def record(name: str, r: dict, text: str) -> None:
        entry = save(out, name, r)
        entry["msPerChar"] = round(r["seconds"] * 1000 / len(text), 1)
        entry["chars"] = len(text)
        report["renders"][name] = entry
        print(f"{name:32} {entry['durationSec']:6.2f}s audio in {entry['renderSec']:6.2f}s  RTF {entry['realTimeFactor']}  {entry['msPerChar']} ms/char  {entry['sampleRate']} Hz", flush=True)

    # 1. Design reference clips (and test repeatability with the same seed).
    t = time.perf_counter()
    design = load_model(snapshot(DESIGN))
    report["designLoadSec"] = round(time.perf_counter() - t, 1)
    for vid, description in voices.items():
        record(f"ref-{vid}", render(design, REFERENCE_TEXT, instruct=description), REFERENCE_TEXT)
    again = render(design, REFERENCE_TEXT, instruct=voices["announcer"])
    report["designRepeatable"] = save(out, "ref-announcer-again", again)["pcmSha256"] == report["renders"]["ref-announcer"]["pcmSha256"]
    (out / "ref-announcer-again.wav").unlink()

    # 4b/4c: per-delivery reference clips, and VoiceDesign per line with the hint.
    if not args.quick:
        for hint, words in DELIVERY_HINTS.items():
            record(f"ref-nobleman-{hint}", render(design, REFERENCE_TEXT, instruct=f"{voices['nobleman']} Speaking {words}."), REFERENCE_TEXT)
            record(f"c-design-per-line-{hint}", render(design, LINES["nobleman-short"], instruct=f"{voices['nobleman']} Speaking {words}."), LINES["nobleman-short"])
    unload(design)

    # 2. Clone from the designed clips with the Base model.
    t = time.perf_counter()
    base = load_model(snapshot(BASE))
    report["baseLoadSec"] = round(time.perf_counter() - t, 1)
    for vid in voices:
        text = LINES.get(vid, REFERENCE_TEXT if vid in ("announcer", "narrator") else LINES["nobleman-short"])
        if vid == "announcer":
            text = "Good evening, listeners, and welcome to Midnight Radio. Tonight: Dracula, chapter two."
        if vid == "narrator":
            text = "Within, stood a tall old man, clean shaven save for a long white moustache, and clad in black from head to foot."
        record(f"clone-{vid}", render(base, text, ref_audio=str(out / f"ref-{vid}.wav"), ref_text=REFERENCE_TEXT), text)
    again = render(base, "Count Dracula?", ref_audio=str(out / f"ref-{list(voices)[0]}.wav"), ref_text=REFERENCE_TEXT)
    first = render(base, "Count Dracula?", ref_audio=str(out / f"ref-{list(voices)[0]}.wav"), ref_text=REFERENCE_TEXT)
    report["cloneRepeatable"] = hashlib.sha256(to_numpy(again["audio"]).tobytes()).hexdigest() == hashlib.sha256(to_numpy(first["audio"]).tobytes()).hexdigest()

    if not args.quick:
        # 4a: clone ignoring the delivery hint; 4b: clone from a per-delivery reference clip.
        record("a-clone-ignore-hint", render(base, LINES["nobleman-short"], ref_audio=str(out / "ref-nobleman.wav"), ref_text=REFERENCE_TEXT), LINES["nobleman-short"])
        for hint in DELIVERY_HINTS:
            record(f"b-clone-from-{hint}-ref", render(base, LINES["nobleman-short"], ref_audio=str(out / f"ref-nobleman-{hint}.wav"), ref_text=REFERENCE_TEXT), LINES["nobleman-short"])
    unload(base)

    clone_ms = [r["msPerChar"] for k, r in report["renders"].items() if k.startswith(("clone-", "a-", "b-"))]
    report["cloneMsPerCharMedian"] = float(np.median(clone_ms)) if clone_ms else None
    (out / "results.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in ("designRepeatable", "cloneRepeatable", "designLoadSec", "baseLoadSec", "cloneMsPerCharMedian")}), flush=True)


if __name__ == "__main__":
    main()
