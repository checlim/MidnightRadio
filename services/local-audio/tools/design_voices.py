"""Render candidate takes for every voice in assets/voices/voices.json, for choosing by ear.

    HF_HUB_OFFLINE=1 .venv/bin/python tools/design_voices.py [--takes 3] [--only id,id] [--out DIR]

Take N of a voice uses seed `seed + N - 1`, so any take can be reproduced exactly. Writes
<out>/<voice>/take-N.wav and <out>/index.html (a page to listen and compare), plus takes.json
with each take's seed and audio hash. The output folder is git-ignored; chosen takes are copied
into the catalogue by tools/assemble_catalogue.py.
"""

import argparse
import hashlib
import html
import json
import sys
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model

ROOT = Path(__file__).resolve().parents[3]
SPEC = ROOT / "assets/voices/voices.json"
DESIGN = ("mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16", "7d3824abff87e49756bb0f83fb5411de75d160c4")


def snapshot(repo: str, revision: str) -> Path:
    path = Path.home() / ".cache/huggingface/hub" / f"models--{repo.replace('/', '--')}" / "snapshots" / revision
    if not (path / "model.safetensors").exists():
        raise SystemExit(f"{repo}@{revision[:7]} is not downloaded (see services/local-audio/README.md)")
    return path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", type=Path, default=SPEC)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "catalogue-candidates")
    ap.add_argument("--takes", type=int, default=3)
    ap.add_argument("--only", default="", help="comma-separated voice ids")
    args = ap.parse_args()

    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    voices = spec["voices"]
    if args.only:
        wanted = set(args.only.split(","))
        voices = [v for v in voices if v["id"] in wanted]
        missing = wanted - {v["id"] for v in voices}
        if missing:
            raise SystemExit(f"unknown voice ids: {', '.join(sorted(missing))}")
    text, base_seed = spec["referenceText"], spec["seed"]
    args.out.mkdir(parents=True, exist_ok=True)
    takes_path = args.out / "takes.json"
    takes = json.loads(takes_path.read_text()) if takes_path.exists() else {}

    model = load_model(snapshot(*DESIGN))
    started = time.perf_counter()
    for i, voice in enumerate(voices, 1):
        folder = args.out / voice["id"]
        folder.mkdir(exist_ok=True)
        for n in range(1, args.takes + 1):
            seed = base_seed + n - 1
            mx.random.seed(seed)
            results = list(model.generate(text=text, lang_code="english", instruct=voice["description"]))
            audio = np.concatenate([np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in results])
            pcm = np.round(np.clip(audio, -1, 1) * 32767).astype("<i2")
            path = folder / f"take-{n}.wav"
            sf.write(path, pcm, results[0].sample_rate, subtype="PCM_16")
            takes.setdefault(voice["id"], {})[str(n)] = {"seed": seed, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "durationSec": round(len(pcm) / results[0].sample_rate, 2)}
        print(f"[{i}/{len(voices)}] {voice['id']:16} {args.takes} takes  ({time.perf_counter() - started:.0f}s so far)", flush=True)
        takes_path.write_text(json.dumps(takes, indent=2))

    write_index(args.out, spec, takes, args.takes)
    print(f"done in {time.perf_counter() - started:.0f}s: open {args.out / 'index.html'}", flush=True)


def write_index(out: Path, spec: dict, takes: dict, count: int) -> None:
    rows = []
    for v in spec["voices"]:
        if v["id"] not in takes:
            continue
        reserved = " <b>(reserved)</b>" if v["id"] in spec["reserved"].values() else ""
        players = "".join(
            f'<td><audio controls preload="none" src="{html.escape(v["id"])}/take-{n}.wav"></audio><br><small>take {n} · seed {takes[v["id"]][str(n)]["seed"]} · {takes[v["id"]][str(n)]["durationSec"]} s</small></td>'
            for n in range(1, count + 1)
            if str(n) in takes[v["id"]]
        )
        rows.append(
            f'<tr><td><b>{html.escape(v["id"])}</b>{reserved}<br>{html.escape(v["name"])} · {v["gender"]} · {", ".join(v["ageBands"])}<br><small>{html.escape(v["description"])}</small></td>{players}</tr>'
        )
    page = f"""<!doctype html><meta charset="utf-8"><title>Voice catalogue candidates</title>
<style>body{{font:15px system-ui;margin:2em}}td{{vertical-align:top;padding:.6em;border-bottom:1px solid #ddd}}td:first-child{{max-width:28em}}small{{color:#555}}</style>
<h1>Voice catalogue candidates</h1>
<p>Each take reads: <i>{html.escape(spec["referenceText"])}</i></p>
<p>For each voice, pick the take that best matches its description and is clearly different from the others. Write the picks into <code>assets/voices/picks.json</code> as <code>{{"voice-id": take-number}}</code>, or tell me, and say which voices to redesign.</p>
<table>{"".join(rows)}</table>"""
    (out / "index.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
