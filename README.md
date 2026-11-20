<p align="center">
  <img src="docs/images/midnight-radio-banner.png" alt="Midnight Radio: an open book releasing glowing scenes of a castle, a figure in a fedora and a sailing ship into a vintage walnut valve radio, beneath a Gothic window and a full moon" width="100%">
</p>

<h3 align="center">Turn DRM-free EPUBs into golden-age radio dramas, played on a vintage valve radio.</h3>

<p align="center"><em>Kiroween 2026 · Resurrection category</em></p>

---

Midnight Radio brings back the 1930s–1950s radio play. Give it a DRM-free EPUB and each chapter becomes an episode: an announcer cold open, a consistent cast of character voices, condensed narration, sound effects, scene ambience, musical stings and a "tune in next time" cliffhanger. You listen through a skeuomorphic valve radio: flip the power switch, and turn the dial to change chapters.

Two promises guide the design:

- **Every character keeps one voice for the whole book.**
- **The story is told faithfully.** Dialogue is quoted verbatim and nothing is invented. The pipeline is designed so that every script must pass an automated dialogue-fidelity check before any audio is generated.

The planned live demo will ship pre-rendered public-domain Gothic fiction (*The Tell-Tale Heart*, *The Fall of the House of Usher*, *Dracula*), so listeners can tune in without triggering any generation. The live site will only play these pre-rendered episodes; generating new ones happens on a local machine.

> **Status: early development.** Built and tested so far: the monorepo, the Script schema, SQLite migrations, the job queue, the worker process, the spend ledger, the generation-route guard, EPUB ingestion (chapters, scene breaks, part splitting, text normaliser), the bundled demo books, casting (character extraction, voice assignment, adding characters and editing voices) and the TTS provider interface with WAV validation, the atomic render cache, per-line rendering with retries and a pre-render plan, and local speech synthesis with Qwen3-TTS (the local audio service, its Apple Silicon backend and a 34-voice catalogue designed with VoiceDesign). Not wired up yet: the worker has no job handlers, and no route or paid call uses the guard or ledger. Not built yet: the sound library and its generation tool, adaptation, validation, mixing, the radio player and the deployment. See [`tasks.md`](.kiro/specs/midnight-radio/tasks.md) for progress.

## How it works

```
EPUB ─▶ Ingest ─▶ Cast ─▶ Adapt ─▶ Validate ─┬─▶ Render (TTS, atomic cache) ─▶ Mix (ffmpeg) ─▶ Episode MP3 + VTT
                                   ▲          │
                                   └─ retry ◀─┘ (≤2, with error + missing-quote feedback)
```

| Stage | What happens |
|---|---|
| **Ingest** | Safely unpack the EPUB, strip front matter and footnotes, extract an inventory of source quotes, and split chapters over 8,000 words. |
| **Cast** | Find the characters and assign each a distinct voice. Announcer and Narrator voices are reserved. |
| **Adapt** | An LLM writes a scene-structured radio script as validated JSON. |
| **Validate** | Check the schema, cast and sound IDs, then score dialogue fidelity (matched source quotes ÷ total). Scripts below 0.90 are retried, then failed, so they never reach TTS. |
| **Render** | Synthesise speech locally with Qwen3-TTS, cloning each voice from a reference clip designed with Qwen3-TTS VoiceDesign. Output goes into a content-addressed WAV cache with atomic writes, so unchanged lines are never rendered twice. |
| **Mix** | Use ffmpeg to assemble scenes, duck ambience under speech, apply an optional AM-radio filter, and master to −16 LUFS. Output is MP3 with WebVTT captions. |

Full details are in [`design.md`](.kiro/specs/midnight-radio/design.md).

## Repository layout

```
apps/
  web/              Valve-radio player and upload UI (planned, Next.js); so far only the generation-route guard
  worker/           Worker process and job queue: leases, heartbeats, crash recovery (no job handlers yet)
packages/
  core/             Script schema (Zod) and JSON Schema generator; validators to come
  db/               SQLite migrations and the spend ledger (budget reservations)
  ingest/           Safe EPUB reading, chapter text, scene breaks and the 8,000-word splitter
  llm/              Casting and adaptation behind a provider-agnostic interface (planned)
  tts/              TtsProvider interface, strict WAV validation, an offline StubProvider, the atomic render cache, per-line retries and the QwenTtsProvider client for the local audio service
  mix/              ffmpeg wrapper (built); ducking and loudness (planned)
services/
  local-audio/      Local Python host for Qwen3-TTS (built, Apple Silicon) and the reference server for the sound-effect API, used only on the generation machine
mcp/
  sfx-library/      MCP server (stdio) over the sound library: search, details, music cues, Script sound audit
fixtures/
  books/            Public-domain Standard Ebooks EPUBs, checksum-pinned, with demo selections (manifest.json)
.kiro/
  specs/            Requirements, design and task plan
  steering/         Product, tech and radio-script style guides for Kiro
```

## Getting started

**Requirements:** Node 24, pnpm 10.18 (via Corepack), Git, and ffmpeg with ffprobe (`brew install ffmpeg` on macOS; developed with 9.0.2). Tests that run ffmpeg are skipped without it; `REQUIRE_FFMPEG=1` makes a missing ffmpeg a failure. Generating episodes (not needed for development or tests) will also need Python and a machine that can run the local audio models: an NVIDIA GPU or Apple Silicon.

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

Run the worker locally (it creates and migrates the database in `DATA_DIR`, then waits for jobs; stop it with Ctrl+C):

```sh
DATA_DIR=./data pnpm -C apps/worker start
```

Regenerate the Script JSON Schema after editing `packages/core/src/schema.ts`:

```sh
pnpm -C packages/core schema:generate
```

## Configuration

Copy `.env.example` to `.env`. Secrets are read only from environment variables and are never logged.

| Variable | Purpose |
|---|---|
| `DATA_DIR` | Persistent directory for the SQLite database (default `/data`). |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | How long the worker waits on SIGTERM to release its current job before exiting (default 4,000, below Fly.io's 5 s and Docker's 10 s kill timeouts). |
| `LLM_API_KEY`, `LLM_MODEL` | Credentials and model for casting and adaptation. Any OpenAI-compatible Chat Completions endpoint with JSON-schema output works. Without a key, no paid LLM call is possible. |
| `LLM_BASE_URL`, `LLM_TIMEOUT_MS` | Endpoint (default `https://api.openai.com/v1`) and per-request timeout (default 90,000 ms). |
| `LOCAL_AUDIO_URL`, `LOCAL_AUDIO_TOKEN` | Where the local audio service listens (loopback addresses only; default `http://127.0.0.1:8765`) and its optional access token. |
| `LOCAL_AUDIO_TIMEOUT_MS`, `LOCAL_AUDIO_MS_PER_CHAR`, `TTS_SEED` | Per-render timeout (default 10 minutes), the assumed render time per character for the pre-render estimate (default 118 ms, measured on an Apple M2 with the 1.7B model; set your own machine's value), and the seed sent with every render. |
| `GLOBAL_DAILY_TTS_CHAR_LIMIT` | TTS characters allowed per UTC day. TTS runs locally, so this limits render time rather than spend. Missing or `0` disables TTS. |
| `GLOBAL_DAILY_LLM_TOKEN_LIMIT` | LLM tokens (input plus capped output) allowed per UTC day. Missing or `0` disables paid LLM calls. |
| `BOOK_TTS_CHAR_LIMIT` | Operator ceiling on any one book's TTS budget (default 60,000). A user-chosen budget can't exceed it. |
| `GENERATION_ENABLED` | Planned. Off by default and always off on the live site: upload, cast editing and every generation route are disabled, and only pre-rendered demos play. Turn it on only on a local machine running the audio models. |
| `UPLOAD_PASSKEY` | Optional judge passkey for all custom generation, sent in the `x-midnight-passkey` header. Demo playback stays public. |

The spend ledger (`packages/db/src/budget.ts`) is built for every LLM call and TTS render to use, but nothing calls it yet. It works like this:

- **Reserving:** before the provider is contacted, the call reserves its expected cost in SQLite. Calls that would exceed a cap are rejected, and the job is parked as `over_budget`.
- **Settling:** usage the provider doesn't report is recorded as the full reserved amount. Usage above the reservation is recorded and counts toward the cap, so later calls are refused.
- **Estimates:** LLM input tokens are an estimate, so a single call can go over by its estimation error.

## Testing

Tests use [Vitest](https://vitest.dev) and [`fast-check`](https://fast-check.dev) property-based tests. Current property suites cover:

- Script schema bounds.
- Lease fencing under random interleavings of workers and clock jumps: only the current lease holder can write, and a job completes at most once.
- Budget caps under random reserve, settle, release and day-change sequences, including unreported usage and usage above the reservation.
- Rate-limiter limits.

Concurrency tests use real processes: several workers claiming from one queue, several processes reserving against one cap, several processes opening a fresh database at once, and render processes killed with SIGKILL before and after the cache publishes a file.

Tests never call paid APIs. There is no CI pipeline yet; once voice rendering lands, tests will use a `StubProvider` that generates local audio.

## Built with Kiro

This project is developed spec-first in [Kiro](https://kiro.dev):

- **Specs:** EARS-format [requirements](.kiro/specs/midnight-radio/requirements.md), a [design](.kiro/specs/midnight-radio/design.md), and a [task plan](.kiro/specs/midnight-radio/tasks.md) traced to requirement IDs.
- **Steering:** [`product.md`](.kiro/steering/product.md) and [`tech.md`](.kiro/steering/tech.md) are always included. [`radio-voice.md`](.kiro/steering/radio-voice.md), the 1940s radio-script style guide, applies to `packages/llm/**`.

- **MCP server:** `mcp/sfx-library` serves four read-only tools over `assets/sfx/index.json`: `search_sfx`, `get_sfx`, `list_music_cues` and `audit_script_sfx`. The audit uses the same checks as the pipeline (`packages/core/src/sfx.ts`). Start it with `node mcp/sfx-library/bin/sfx-library.mjs`; register it in `.kiro/settings/mcp.json` to use it in Kiro.
- **Custom agent:** [`script-auditor`](.kiro/agents/script-auditor.md) checks a Script's sounds with those tools and suggests valid replacements. It is read-only and brings its own copy of the server.
- Agent hooks are planned and will be documented here once they exist.

## Content and rights

- Demo content is public-domain fiction only.
- Midnight Radio does not circumvent DRM and does not clone real people's voices.
- Generated episodes are AI-produced and will be labelled as such in the player.
- Character voices are designed from written descriptions with Qwen3-TTS VoiceDesign, never copied from a real person.
- Sound effects and music will be CC0 or project-created (some foley generated offline through the [sound-effect service API](docs/sfx-service-api.md), with a model of the operator's choosing, such as MOSS-SoundEffect v2.0), with each asset's source and licence listed in `ATTRIBUTION.md`.

## License

The source code is released under the [MIT License](LICENSE).

Bundled books, sound effects and music are not covered by that licence. They keep their own terms, which will be listed in `ATTRIBUTION.md`. The books are public-domain texts, and the Standard Ebooks editions' markup is dedicated to the public domain under CC0.
