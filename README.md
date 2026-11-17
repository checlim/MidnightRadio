<p align="center">
  <img src="docs/images/midnight-radio-banner.png" alt="Midnight Radio: an open book releasing glowing scenes of a castle, a figure in a fedora and a sailing ship into a vintage walnut valve radio, beneath a Gothic window and a full moon" width="100%">
</p>

<h3 align="center">Turn DRM-free EPUBs into golden-age radio dramas, played on a vintage valve radio.</h3>

<p align="center"><em>Kiroween 2026 · Resurrection category</em></p>

---

Midnight Radio brings back the 1930s–1950s radio play. Give it a DRM-free EPUB and each chapter becomes an episode: an announcer cold open, a consistent cast of character voices, condensed narration, sound effects, scene ambience, musical stings and a "tune in next time" cliffhanger. You listen through a skeuomorphic valve radio: flip the power switch, and turn the dial to change chapters.

Two promises guide the design:

- **Every character keeps one voice for the whole book.**
- **The story is told faithfully.** Dialogue is quoted verbatim and nothing is invented. Each script must pass an automated dialogue-fidelity check before any audio is generated.

The live demo ships pre-rendered public-domain Gothic fiction (*The Tell-Tale Heart*, *The Fall of the House of Usher*, *Dracula*), so listeners can tune in without triggering any paid generation.

> **Status: early development.** The monorepo, Script schema, SQLite persistence, resumable job queue and spend guardrails are built and tested. Ingestion, adaptation, voice rendering, mixing and the radio player are not built yet. See [`tasks.md`](.kiro/specs/midnight-radio/tasks.md) for progress.

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
| **Validate** | Check the schema, cast and sound IDs, then score dialogue fidelity (matched source quotes ÷ total). Scripts below 0.90 are retried, then failed, so they never reach paid TTS. |
| **Render** | Synthesise speech into a content-addressed WAV cache with atomic writes, so unchanged lines are never paid for twice. |
| **Mix** | Use ffmpeg to assemble scenes, duck ambience under speech, apply an optional AM-radio filter, and master to −16 LUFS. Output is MP3 with WebVTT captions. |

Full details are in [`design.md`](.kiro/specs/midnight-radio/design.md).

## Repository layout

```
apps/
  web/              Next.js valve-radio player and upload UI (generation-route guards so far)
  worker/           Resumable job runner: leases, heartbeats, crash recovery
packages/
  core/             Script schema (Zod) and JSON Schema generator; validators to come
  db/               SQLite migrations and the spend ledger (budget reservations)
  ingest/           EPUB to canonical chapters (planned)
  llm/              Casting and adaptation behind a provider-agnostic interface (planned)
  tts/              TtsProvider interface, render cache and StubProvider (planned)
  mix/              ffmpeg wrapper, ducking and loudness (planned)
mcp/
  sfx-library/      MCP server for curating CC0 sound assets in Kiro (planned)
.kiro/
  specs/            Requirements, design and task plan
  steering/         Product, tech and radio-script style guides for Kiro
```

## Getting started

**Requirements:** Node 24, pnpm 10.18 (via Corepack) and Git. ffmpeg is needed once the mixing stage lands.

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

Regenerate the Script JSON Schema after editing `packages/core/src/schema.ts`:

```sh
pnpm -C packages/core schema:generate
```

## Configuration

Copy `.env.example` to `.env`. Secrets are read only from environment variables and are never logged.

| Variable | Purpose |
|---|---|
| `GLOBAL_DAILY_TTS_CHAR_LIMIT` | TTS characters allowed per UTC day. Missing or `0` disables paid TTS. |
| `GLOBAL_DAILY_LLM_TOKEN_LIMIT` | LLM tokens (input plus capped output) allowed per UTC day. Missing or `0` disables paid LLM calls. |
| `BOOK_TTS_CHAR_LIMIT` | Operator ceiling on any one book's TTS budget (default 60,000). A user-chosen budget can't exceed it. |
| `UPLOAD_PASSKEY` | Optional judge passkey for all custom generation, sent in the `x-midnight-passkey` header. Demo playback stays public. |

Every paid call reserves its worst-case cost in SQLite before the provider is contacted. Calls that would exceed a cap are rejected, and the job is parked as `over_budget`.

## Testing

Tests use [Vitest](https://vitest.dev) and [`fast-check`](https://fast-check.dev) property-based tests. Current property suites cover:

- Script schema bounds.
- Lease fencing under random interleavings of workers and clock jumps: only the current lease holder can write, and a job completes at most once.
- Budget caps under random reserve, settle, release and day-change sequences.
- Rate-limiter limits.

CI uses a `StubProvider`, so tests never call paid APIs.

## Built with Kiro

This project is developed spec-first in [Kiro](https://kiro.dev):

- **Specs:** EARS-format [requirements](.kiro/specs/midnight-radio/requirements.md), a [design](.kiro/specs/midnight-radio/design.md), and a [task plan](.kiro/specs/midnight-radio/tasks.md) traced to requirement IDs.
- **Steering:** [`product.md`](.kiro/steering/product.md) and [`tech.md`](.kiro/steering/tech.md) are always included. [`radio-voice.md`](.kiro/steering/radio-voice.md), the 1940s radio-script style guide, applies to `packages/llm/**`.

Agent hooks, the `sfx-library` MCP server and a `script-auditor` custom agent are planned and will be documented here once they exist.

## Content and rights

- Demo content is public-domain fiction only.
- Midnight Radio does not circumvent DRM and does not clone real people's voices.
- Generated episodes are AI-produced and will be labelled as such in the player.
- Sound effects and music will be CC0 or project-created, with sources recorded in the asset catalogue.
