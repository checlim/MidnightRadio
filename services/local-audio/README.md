# local-audio

A small HTTP service that hosts the speech model (Qwen3-TTS) on **the generation machine**, and implements the [sound-effect service API](../../docs/sfx-service-api.md) on loopback. It is never part of the deployed container: the live site only plays pre-rendered episodes.

**Status.** Two backends: `qwen-mlx` speaks with Qwen3-TTS on Apple Silicon (built and tested against the real model on an M2), and `fake` returns tones for tests. No real sound-effect backend is built here: on a 16 GB M2, MOSS-SoundEffect v2.0 takes 11–12.5 minutes per clip (Task 6.1 spike), so foley comes from a remote server implementing the same API.

## Run (fake backend)

Needs [uv](https://docs.astral.sh/uv/) and Python 3.10 or newer. The server itself uses only the standard library.

```sh
cd services/local-audio
uv run --no-project --python ">=3.10" python -m local_audio \
  --catalogue path/to/catalogue.json --backend fake --port 8765
```

It prints `{"listening": "http://127.0.0.1:8765"}` when ready and stops cleanly on SIGTERM or Ctrl+C. `--port 0` picks a free port.

Test it (standard-library `unittest`, no installs):

```sh
cd services/local-audio
uv run --no-project --python ">=3.10" python -m unittest discover -s tests -t .
```

## Settings

| Setting | Meaning |
|---|---|
| `--catalogue` | Path to `catalogue.json` (required). Every voice needs a reference clip with a SHA-256 and a transcript; the service refuses to start if a clip is missing, outside the catalogue directory, or does not match its hash. |
| `--backend` | Required, so a real run can never silently fall back to tones. |
| `--host` | Loopback only (`127.0.0.1` or `localhost`). Anything else is refused. |
| `--port` | Default 8765. |
| `LOCAL_AUDIO_TOKEN` | Optional access token, at least 16 characters, read from the environment only (never from the command line). When set, every endpoint needs `Authorization: Bearer <token>`. |

## API (version 1)

| Endpoint | Request | Answer |
|---|---|---|
| `GET /health` | none | JSON: service name, `apiVersion`, backend, `tts` and `sfx` model info (`model`, `revision`, `sampleRate`, `ready`; `sfx` also `license` and optional `weightsSha256`), and for every voice its `clipSha256` and `transcriptSha256`. The TypeScript client compares these with its catalogue before trusting any audio. |
| `POST /tts` | JSON `{voiceId, text, delivery?, seed?}` | `audio/wav` (24 kHz, mono, 16-bit) with `X-Model-Revision` and `X-Render-Ms`. |
| `POST /sfx` | JSON `{prompt, durationSec, seed?}` | `audio/wav` (mono, 16-bit) with `X-Model-Revision`. The full contract, which remote servers also follow, is [`docs/sfx-service-api.md`](../../docs/sfx-service-api.md). |

Errors are JSON `{"error": {"code", "message"}}`: 400 bad request, 401 unauthorized, 403 bad host or origin, 404 unknown voice or path, 405 wrong method, 411 and 413 and 415 for the body, 503 busy or not ready, 500 internal (no details).

## Safety

It is a model server on a personal machine, so:

- it listens on loopback only, and the `Host` header must name that address and port, which blocks DNS-rebinding pages;
- any request carrying an `Origin` header (a web page) is refused;
- only JSON, with a 64 KB body limit and strict field checks;
- the token is compared in constant time and is never logged or echoed;
- one model call runs at a time; others wait, up to a time limit, then get 503;
- logs contain the method, path and status only: never bodies, headers or tokens, so dialogue text is not logged;
- unexpected errors return a generic 500, with only the exception type logged.

## The `qwen-mlx` backend (Apple Silicon)

Clones each catalogue voice from its reference clip with Qwen3-TTS 1.7B Base, so a character sounds the same on every line. Delivery hints are accepted but not used (Task 5.1 decision, option a), so each voice stays identical on every line. Needs Python 3.11+ for `mlx-audio`; this was set up and measured on an Apple M2 with 16 GB.

1. Install the exact package set into a local, git-ignored environment:

   ```sh
   cd services/local-audio
   uv venv --python 3.13 .venv
   VIRTUAL_ENV=.venv uv pip install -r requirements-mlx.txt
   ```

2. Download the pinned weights (about 4.5 GB each; VoiceDesign is only needed to design new catalogue voices):

   ```sh
   .venv/bin/python -c "from huggingface_hub import snapshot_download as d; \
     d('mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16', revision='a6eb4f68e4b056f1215157bb696209bc82a6db48'); \
     d('mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16', revision='7d3824abff87e49756bb0f83fb5411de75d160c4')"
   ```

   Pinned weights: Base `model.safetensors` SHA-256 `81fb76175ff74e69be25fef2cc3e54f016df3034f1514c8e1c89da06a3510cff`; VoiceDesign `96ae28bec2205ec0b5e0c750bea2b8a5deac4f14d33a8a25a5f753299486b70e`; shared speech tokenizer `836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258`. The backend hashes the Base weights at start-up and reports the hash on `/health`; the client refuses weights other than the ones the catalogue pins.

3. Run it offline against the local snapshot (never another revision, never a download):

   ```sh
   HF_HUB_OFFLINE=1 .venv/bin/python -m local_audio --catalogue ../../assets/voices/catalogue.json \
     --backend qwen-mlx \
     --tts-model ~/.cache/huggingface/hub/models--mlx-community--Qwen3-TTS-12Hz-1.7B-Base-bf16/snapshots/a6eb4f68e4b056f1215157bb696209bc82a6db48
   ```

Measured on the M2 (Task 5.1 spike, `spike/run_spike.py`): 24 kHz mono output; about 1.2–1.6 s of compute per second of audio, median 118 ms per character (the client's default estimate); a fixed seed gives byte-identical audio across processes; one model in memory at a time fits in 16 GB.

Tests that need the model are skipped elsewhere. To run them here:

```sh
MR_QWEN_BASE=<Base snapshot dir> MR_QWEN_DESIGN=<VoiceDesign snapshot dir> HF_HUB_OFFLINE=1 \
  .venv/bin/python -m unittest tests.test_qwen_mlx
```

## Rebuilding the voice catalogue

`assets/voices/catalogue.json` is built from the designs in `assets/voices/voices.json` (needs the VoiceDesign weights):

1. Render three candidate takes per voice into the git-ignored `catalogue-candidates/` folder, then open its `index.html` to listen:
   ```sh
   HF_HUB_OFFLINE=1 .venv/bin/python tools/design_voices.py --takes 3
   ```
   Take N uses seed 1940 + N − 1, so every take can be reproduced. `--only id,id` renders just some voices.
2. Record the chosen take for each voice in `assets/voices/picks.json`.
3. Copy the chosen takes into `assets/voices/clips/` and write the catalogue with their hashes (standard library only):
   ```sh
   uv run --no-project --python 3.10 python tools/assemble_catalogue.py
   ```

A changed catalogue changes its catalogue hash, which `packages/tts/src/voice-catalogue.test.ts` pins; update the pin in the same commit.

A CUDA backend (`qwen-torch`, `qwen-tts`) is not built. Neither is a sound-effect backend; any server implementing [the sound-effect API](../../docs/sfx-service-api.md) can be used instead.

## Generating foley

`tools/generate_sfx.py` renders candidate takes of every cue in `assets/sfx/prompts.json` through any server that implements the [sound-effect service API](../../docs/sfx-service-api.md): this service on loopback, or a remote GPU (for example a notebook behind a tunnel) that you run yourself. Standard library only, so any Python 3.10+ works:

```sh
SFX_SERVICE_URL=https://<your-tunnel-host> SFX_SERVICE_TOKEN=<token> \
  python tools/generate_sfx.py --takes 3            # --only door_creak,rain for a few cues
```

- Take N of a cue uses seed `seed + N - 1`. Takes go to the git-ignored `sfx-candidates/` folder (`<cue>/take-N.wav` as the server sent them, `takes.json`, and `index.html` to listen and compare).
- Stop and restart at any time, also with a new tunnel URL: takes that still match their prompt, duration and seed are kept, failed ones are retried.
- The folder belongs to one model. If the server reports a different model or revision, the tool stops; use another `--out` folder for another model.
- Plain `http` is accepted only for `127.0.0.1`/`localhost`; any other host needs `https` and a token. Redirects are refused, and the token never appears in output.
- Exit status: 0 every take rendered, 1 some takes failed (rerun to retry), 2 stopped (configuration, refused request or model change).

To try it without a model, run this service with `--backend fake` and point `SFX_SERVICE_URL` at it.

Then choose takes and build the library:

1. Listen in `sfx-candidates/index.html` and put the chosen take number for each cue in `assets/sfx/picks.json` (`null` leaves a cue out for now).
2. From the repo root, with ffmpeg installed: `pnpm --filter @midnight-radio/mix sfx:assemble` (add `--candidates <dir>` for another folder).

It checks each pick is the take recorded for the current prompt and seed and that the file is unchanged, converts it to 24 kHz mono 16-bit, crossfades a bed's tail into its head so it loops without a seam, gives discrete sounds 5 ms and 30 ms edge fades, normalises the peak to −1 dBFS, and checks the length, peak, edges and loop point. It writes `assets/sfx/foley/` and `assets/sfx/beds/`, `assets/sfx/index.json` (sounds it did not make, music cues and edited titles are kept) and the sound section of `ATTRIBUTION.md`, and lists any sudden jumps worth a listen. The candidates folder keeps the original takes as masters. Running it again gives identical files.

## Adding CC0 sounds and music

Music cues (theme, sting, transition) and any found foley come from CC0 sources, not the generator. After confirming the CC0 dedication on the source page:

```sh
pnpm --filter @midnight-radio/mix sfx:import -- --file music-candidates/tutti-bombwerk.wav \
  --id main_theme --kind music --title "Main theme" --cue theme \
  --source https://commons.wikimedia.org/wiki/File:Tutti-Bombwerk.wav --author "Vox Mirabilis" \
  --start 12 --duration 20
```

It trims the excerpt, converts it to 24 kHz mono 16-bit (stereo is mixed down), fades music out over 1 s (`--fade-out` to change; `--loop` makes a seamless bed instead), normalises the peak to −1 dBFS, records the source page, author, original file hash and excerpt in `index.json`, pins `--cue` if given, and updates `ATTRIBUTION.md`. Importing the same `--id` from the same `--source` again replaces it, so the excerpt can be adjusted.
