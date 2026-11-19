# local-audio

A small HTTP service that hosts the audio models (Qwen3-TTS for speech, MOSS-SoundEffect v2.0 for foley) on **the generation machine**. It is never part of the deployed container: the live site only plays pre-rendered episodes.

**Status.** The server, its safety checks and the catalogue verification are built and tested. Only the `fake` backend exists, which returns tones and no speech, so the TypeScript client and the tests can be developed without any model. The real backends are written in the Task 5.1 spike, after the weights are downloaded and measured on this machine. Asking for any other backend exits with "not implemented yet".

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
| `GET /health` | none | JSON: service name, `apiVersion`, backend, `tts` and `sfx` model info (`model`, `revision`, `sampleRate`, `ready`), and for every voice its `clipSha256` and `transcriptSha256`. The TypeScript client compares these with its catalogue before trusting any audio. |
| `POST /tts` | JSON `{voiceId, text, delivery?, seed?}` | `audio/wav` (24 kHz, mono, 16-bit) with `X-Model-Revision` and `X-Render-Ms`. |
| `POST /sfx` | JSON `{prompt, durationSec, seed?}` | `audio/wav` (mono, 16-bit). |

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

## Real backends (not built yet)

Planned from the design: `qwen-mlx` (Apple Silicon, `mlx-audio`) and `qwen-torch` (CUDA, `qwen-tts`) for Qwen3-TTS Base voice cloning, and a MOSS-SoundEffect v2.0 backend for `/sfx`. Weights are loaded from a local path and pinned by hash; nothing is downloaded at render time. Setup instructions will be recorded here after the spike has run them on a real machine.
