"""Render candidate takes of every foley cue in assets/sfx/prompts.json, for choosing by ear.

    SFX_SERVICE_URL=https://… SFX_SERVICE_TOKEN=… python tools/generate_sfx.py [--takes 3] [--only id,id] [--out DIR]

Talks to any server that implements the sound-effect service API (docs/sfx-service-api.md): the
local service, or a remote GPU behind a tunnel. Take N of a cue uses seed `seed + N - 1`. Writes
<out>/<cue>/take-N.wav (as the server sent it, e.g. 48 kHz), <out>/takes.json (prompt, seed, hash
and the model the server reported, per take) and <out>/index.html (a page to listen and compare).

Safe to stop and start again, including with a new server URL: takes already on disk that match
the current prompt, duration and seed are kept. If the server's model differs from the one the
folder was started with, it stops; use another --out folder for another model. Standard library only.

Exit status: 0 all takes rendered, 1 some takes failed (rerun to retry them), 2 stopped.
"""
import argparse
import hashlib
import html
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from local_audio.sfx_client import MAX_SEED, ModelInfo, SfxClient, SfxClientError, SfxFatalError, load_config  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
PROMPTS = ROOT / "assets/sfx/prompts.json"
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "sfx-candidates"
ATTEMPTS = 3
_CUE_ID = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
_TAG = re.compile(r"^[a-z][a-z0-9-]{0,23}$")


class PromptsError(Exception):
    pass


def load_prompts(path: Path, takes: int) -> list:
    """The cue list, checked. Raises PromptsError naming the first problem."""
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as err:
        raise PromptsError(f"cannot read {path.name}: {type(err).__name__}") from None
    if not isinstance(spec, dict) or spec.get("version") != 1 or not isinstance(spec.get("cues"), list) or not spec["cues"]:
        raise PromptsError(f"{path.name} must be {{\"version\": 1, \"cues\": [...]}} with at least one cue")
    allowed = {"id", "prompt", "durationSec", "seed", "loopable", "tags"}
    seen = set()
    for i, cue in enumerate(spec["cues"]):
        where = f"cue {i + 1}"
        if not isinstance(cue, dict):
            raise PromptsError(f"{where} is not an object")
        extra = set(cue) - allowed
        if extra:
            raise PromptsError(f"{where} has unknown fields: {', '.join(sorted(extra))}")
        cid = cue.get("id")
        if not isinstance(cid, str) or not _CUE_ID.match(cid):
            raise PromptsError(f"{where}: id must be 2–48 lower-case letters, digits or _ starting with a letter")
        where = f"cue {cid!r}"
        if cid in seen:
            raise PromptsError(f"{where} appears twice")
        seen.add(cid)
        prompt = cue.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 500:
            raise PromptsError(f"{where}: prompt must be 1 to 500 characters")
        duration = cue.get("durationSec")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not 0.5 <= duration <= 30:
            raise PromptsError(f"{where}: durationSec must be between 0.5 and 30")
        seed = cue.get("seed")
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= MAX_SEED - takes:
            raise PromptsError(f"{where}: seed must be an integer from 0 to {MAX_SEED - takes}")
        if not isinstance(cue.get("loopable"), bool):
            raise PromptsError(f"{where}: loopable must be true (an ambience bed) or false (a discrete sound)")
        tags = cue.get("tags", [])
        if not isinstance(tags, list) or len(tags) > 8 or not all(isinstance(t, str) and _TAG.match(t) for t in tags):
            raise PromptsError(f"{where}: tags must be up to 8 short lower-case words")
    return spec["cues"]


def _write_atomic(path: Path, data: bytes) -> None:
    """Unique temp file in the same folder, flushed, then renamed over the target."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    try:
        with open(tmp, "xb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _matches(entry: Optional[dict], cue: dict, seed: int, folder: Path) -> bool:
    """A take on disk is kept only if it was made from this exact request and the file is unchanged."""
    if not entry or entry.get("prompt") != cue["prompt"] or entry.get("durationSec") != cue["durationSec"] or entry.get("seed") != seed:
        return False
    path = folder / entry.get("file", "")
    return path.is_file() and _sha256(path.read_bytes()) == entry.get("sha256")


def run(
    cues: list,
    out: Path,
    client: SfxClient,
    takes: int = 3,
    only: Optional[set] = None,
    log: Callable[[str], None] = print,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Render every missing take. Returns the exit status (0, 1 or 2)."""
    if only:
        unknown = only - {c["id"] for c in cues}
        if unknown:
            log(f"unknown cue ids: {', '.join(sorted(unknown))}")
            return 2
        cues = [c for c in cues if c["id"] in only]
    out.mkdir(parents=True, exist_ok=True)
    state_path = out / "takes.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {"model": None, "takes": {}}

    def save() -> None:
        _write_atomic(state_path, json.dumps(state, indent=2).encode("utf-8"))
        _write_atomic(out / "index.html", listening_page(cues, state).encode("utf-8"))

    try:
        model = client.health()
    except SfxFatalError as err:
        log(f"stopped: {err}")
        return 2
    if state["model"] is not None and state["model"] != model.identity():
        log(f"stopped: {out} holds takes from {state['model'].get('model')}@{str(state['model'].get('revision'))[:12]}, "
            f"but the server now runs {model.model}@{model.revision[:12]}. Use another --out folder for another model.")
        return 2
    state["model"] = model.identity()
    log(f"server: {model.model}@{model.revision[:12]} ({model.license}, {model.sample_rate} Hz)")

    failed = 0
    for cue in cues:
        folder = out / cue["id"]
        folder.mkdir(exist_ok=True)
        entries = state["takes"].setdefault(cue["id"], {})
        for n in range(1, takes + 1):
            seed = cue["seed"] + n - 1
            if _matches(entries.get(str(n)), cue, seed, folder):
                continue
            try:
                entry = _render_take(client, cue, n, seed, model, folder, log, sleep)
            except SfxFatalError as err:
                save()
                log(f"stopped: {err}")
                return 2
            if entry is None:
                failed += 1
                entries.pop(str(n), None)
            else:
                entries[str(n)] = entry
            save()
    save()
    log(f"done: {failed} take(s) failed; rerun to retry them" if failed else "done: every take rendered")
    return 1 if failed else 0


def _render_take(client: SfxClient, cue: dict, n: int, seed: int, model: ModelInfo, folder: Path, log, sleep) -> Optional[dict]:
    for attempt in range(1, ATTEMPTS + 1):
        started = time.monotonic()
        try:
            wav, info, render_ms = client.render(cue["prompt"], cue["durationSec"], seed, model)
        except SfxClientError as err:
            log(f"{cue['id']} take {n}: attempt {attempt} failed: {err}")
            if attempt < ATTEMPTS:
                sleep(2.0 ** attempt)
            continue
        name = f"take-{n}.wav"
        _write_atomic(folder / name, wav)
        took = round(time.monotonic() - started, 1)
        log(f"{cue['id']} take {n}: {info.duration_s:.1f} s in {took} s")
        return {
            "prompt": cue["prompt"],
            "durationSec": cue["durationSec"],
            "seed": seed,
            "file": name,
            "sha256": _sha256(wav),
            "sampleRate": info.sample_rate,
            "frames": info.frames,
            "peak": info.peak,
            "renderMs": render_ms,
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
    log(f"{cue['id']} take {n}: gave up after {ATTEMPTS} attempts")
    return None


def listening_page(cues: list, state: dict) -> str:
    """A static page with every take, to compare by ear. All text is escaped."""
    model = state.get("model") or {}
    rows = []
    for cue in cues:
        takes = state["takes"].get(cue["id"], {})
        players = "".join(
            f'<figure><figcaption>take {html.escape(n)} · seed {int(t["seed"])}</figcaption>'
            f'<audio controls preload="none" src="{html.escape(cue["id"])}/{html.escape(t["file"])}"></audio></figure>'
            for n, t in sorted(takes.items(), key=lambda kv: int(kv[0]))
        ) or "<p>no takes yet</p>"
        kind = "ambience bed (loop)" if cue["loopable"] else "discrete sound"
        rows.append(
            f'<section><h2>{html.escape(cue["id"])}</h2><p>{html.escape(cue["prompt"])}<br>'
            f'<small>{float(cue["durationSec"]):.1f} s · {kind}</small></p>{players}</section>'
        )
    title = f'{html.escape(str(model.get("model", "")))} @ {html.escape(str(model.get("revision", ""))[:12])} · {html.escape(str(model.get("license", "")))}'
    return (
        '<!doctype html><meta charset="utf-8"><title>Midnight Radio foley takes</title>'
        "<style>body{font:15px system-ui;margin:2em;max-width:60em}section{border-top:1px solid #ccc;padding:.5em 0}"
        "figure{display:inline-block;margin:.3em 1em .3em 0}figcaption{font-size:12px;color:#555}</style>"
        f"<h1>Foley takes</h1><p>{title}. Record the take you choose for each cue in assets/sfx/picks.json.</p>" + "".join(rows)
    )


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--prompts", type=Path, default=PROMPTS)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--takes", type=int, default=3, choices=range(1, 11), metavar="1-10")
    ap.add_argument("--only", default="", help="comma-separated cue ids")
    args = ap.parse_args(argv)
    try:
        cues = load_prompts(args.prompts, args.takes)
        config = load_config(os.environ)
    except (PromptsError, SfxFatalError) as err:
        print(f"stopped: {err}", file=sys.stderr)
        return 2
    only = {s.strip() for s in args.only.split(",") if s.strip()} or None
    return run(cues, args.out, SfxClient(config), args.takes, only)


if __name__ == "__main__":
    sys.exit(main())
