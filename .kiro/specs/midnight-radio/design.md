# Design Document — Midnight Radio

## Overview

A single TypeScript monorepo: a Next.js web app (vintage valve-radio player + upload), a Node worker that runs the resumable pipeline, and an MCP server exposing the curated CC0 sound library to Kiro and custom agents during development. Audio assembly uses `ffmpeg`. State lives in SQLite on a persistent volume (`/data`); rendered audio and pre-rendered Gothic demo episodes live on local persistent disk (S3-compatible storage optional).

```
EPUB ─▶ Ingest ─▶ Cast ─▶ Adapt ─▶ Validate ─┬─▶ Render (TTS, atomic cache) ─▶ Mix (ffmpeg) ─▶ Episode MP3 + VTT
                                   ▲          │
                                   └─ retry ◀─┘ (≤2, with error + missing-quote feedback)
```

## Architecture & Deployment Topology

| Component | Responsibility | Tech |
|---|---|---|
| `apps/web` | Upload, cast editor, vintage valve-radio player | Next.js (App Router), Web Audio API |
| `apps/worker` | Resumable job runner for the pipeline | Node 24, SQLite-backed job queue |
| `packages/core` | Domain types, Script schema, quote extractor, validators | TypeScript, Zod, `fast-check` (PBT) |
| `packages/ingest` | EPUB → canonical chapters (inline-safe XHTML + quote norm) | `jszip` + HTML-to-text |
| `packages/llm` | Casting and single-pass structured JSON adaptation | OpenAI-compatible client (provider-agnostic) |
| `packages/tts` | `TtsProvider` interface, atomic render cache + providers | Cloud provider + `StubProvider` |
| `packages/mix` | Scene assembly, sidechain ducking, AM filter, loudness | `ffmpeg` via single logged wrapper |
| `mcp/sfx-library` | Curate/search/audit CC0 sound assets inside Kiro & tests | MCP server (stdio) |

### Live Judge URL Deployment

The reference deployment is **one container, one replica**: Node 24 `apps/web` + `apps/worker`, `ffmpeg`, and a persistent `/data` volume on a suitable container host or VPS. Use a supervisor/init that forwards signals, reaps children, and restarts or fails the container if either service dies; expose health/readiness checks. SQLite, job state, cache, uploads, and exports all live under `/data`. Back up the DB and volume; test stop/restart and redeploy persistence. This avoids a stateless/serverless worker for the reference build, without claiming other deployments are impossible.

Seed immutable pre-rendered MP3/VTT/source fixtures from the image or a checksum-pinned asset bundle, idempotently and **without paid API calls on boot**. Ship at least two stations (a short Gothic work or labelled contiguous excerpt plus *Dracula* Ch. 1). Choose a separate source-supported dialogue passage for multi-voice demonstrations; Poe's openings and *Dracula* Ch. 1 are not automatically dialogue-rich. Playback begins only after a user gesture; target first sound within 5 seconds on a documented test connection, not an unconditional page-load autoplay promise.

## Data Model (SQLite)

- `books(id, title, author, source_hash, char_budget, status, is_demo, created_at)`
- `chapters(id, book_id, idx, title, part, source_text, canonical_text, quote_spans_json, normaliser_version, word_count, status)`
- `cast_members(id, book_id, name, aliases_json, role, gender_hint, age_band, voice_id, description, added_in_chapter)`
- `scripts(id, chapter_id, version, json, validation_json, fidelity, status)`
- `segments(id, script_id, section, scene_idx, idx, kind, speaker, text, contains_verbatim_quote, sfx_id, delivery, cache_key, audio_path, duration_ms, status)` — `section` is coldOpen/scenes/close; `scene_idx` is nullable outside scenes; order is explicit.
- `episodes(id, chapter_id, mp3_path, clean_mp3_path, vtt_path, duration_ms, lufs, true_peak)`
- `jobs(id, kind, ref_id, state, attempts, lease_until, lease_token, error, updated_at)`
- `usage(id, day_utc, book_id, chapter_id, llm_in, llm_out, tts_chars, wall_ms)` — `chapter_id` is nullable for book-wide casting.
- `budget_reservations(id, job_id, day_utc, book_id, chapter_id, provider_request_id, llm_tokens, tts_chars, state)` — durable reservation/settlement state for concurrent calls and uncertain outcomes.

## Script Schema (`packages/core`)

Beds are scoped cleanly to `Scene` blocks rather than loose linear items, giving `ffmpeg` deterministic start/end boundaries for sidechain ducking:

```ts
type Delivery = "neutral" | "whisper" | "urgent" | "fearful" | "sinister" | "warm";

type Segment =
  | { kind: "announcer"; text: string; delivery?: Delivery }
  | { kind: "narration"; text: string; delivery?: Delivery; containsVerbatimQuote?: boolean }
  | { kind: "dialogue"; speaker: string; text: string; delivery?: Delivery }
  | { kind: "sfx"; sfxId: string; durationMs?: number }
  | { kind: "music"; cue: "theme" | "sting" | "transition"; durationMs?: number }
  | { kind: "pause"; ms: number };

interface SceneBed {
  kind: "sfx" | "music";
  id: string;        // ID in assets/sfx/index.json, matching this bed's kind
  gainDb?: number;   // bounded [-40, 0], default -14 dB before speech ducking
}

interface Scene {
  id: string;
  title?: string;
  ambience?: SceneBed;
  segments: Segment[];
}

interface Script {
  bookId: string;
  chapterId: string;
  episodeNumber: number;
  coldOpen: Segment[];   // first segment is announcer; any theme cue follows
  scenes: Scene[];       // dramatic body with scene-scoped beds
  close: Segment[];      // must contain cliffhanger announcer line + theme
}
```

This is a design sketch, not implemented types. Zod SHALL reject unknown fields; require non-empty scenes, segment lists, and speech text; enforce unique Scene IDs, finite non-negative integer durations (positive for pauses), and configured duration/gain bounds. Narrator quote flags are untrusted claims that the validator must verify. A Scene has at most one bed in the MVP; simultaneous music and ambience is deferred.

`assets/sfx/index.json` is one versioned catalogue for both SFX and music: unique `id`, `kind`, safe relative `path`, file hash, `durationMs`, `loopable`, tags, source and licence. A pinned cue map resolves theme/sting/transition to music IDs. Validate kind as well as existence, and require loopable beds. Runtime and MCP use the same catalogue and pure validator.

`sourceSpan` offsets are intentionally absent from LLM output. Deterministic source-side spans, quote parse diagnostics, and normaliser version are stored for audits; never ask a model to count offsets.

## Pipeline Detail

1. **Ingest** — verify EPUB ZIP/OPF/spine rather than trusting the suffix. Bound archive entry count, expanded bytes, compression ratio and parsing time; reject traversal/absolute paths and external XML entities; never fetch remote book resources. Strip semantic nav/TOC/front matter, footnote markers and images, not arbitrary text containing those words. Preserve text-node whitespace and inline adjacency (`<em>w</em>ord` → `word`, `word <em>two</em>` → `word two`); introduce breaks at block boundaries and explicit `<br>`/`<hr>`. Preserve `source_text` and scene/paragraph breaks. Extract quote spans before flattening directional marks. The versioned comparison normaliser applies Unicode NFC, folds curly quotes/apostrophes to straight equivalents and en/em dashes to `-`, and collapses whitespace for matching only; no lowercasing, word deletion, or general punctuation removal. Detect scene boundaries before whitespace folding. Split >8,000-word chapters at scene/paragraph boundaries, then sentence/word boundaries if a paragraph is oversized. Define words as whitespace-delimited tokens consistently; a long single token counts as one, not an exception. Preserve canonical token order and retain source mapping when a quote crosses a part boundary. Parse quotes before splitting: each part receives the exact intersecting quote fragment, parent quote ID and continuation flags. Validate fragment completeness/order within the part; aggregate original-quote coverage only when all its fragments pass. Do not re-parse artificial part boundaries as unbalanced quotes.
2. **Cast** — budgeted, bounded map-reduce over full-book character evidence → validated and frozen inventory with stable IDs, aliases and source-derived counts. Determinism applies to voice assignment from this inventory, not to arbitrary repeat LLM extractions. Pin provider/model/voice catalogue, sort by `(mentionCount DESC, normalisedName ASC, id ASC)`, reserve Announcer/Narrator voices, then allocate unique remaining voices with a fixed seed and stable tie-break. Pause on catalogue exhaustion; do not share voices silently. Later additions leave existing assignments intact. Cast edits enforce distinct/non-reserved voices and invalidate changed speech only, but re-mix affected episodes and rebuild their VTT/markers after durations change. Supply adaptation only chapter-local character descriptions/aliases, not full-book biographies or future plot facts.
3. **Adapt** — one structured JSON request per attempt using `radio-voice.md`, the chapter-local Cast view, a compact allowlist from `assets/sfx/index.json` (target 30–50 cues; no runtime stdio MCP loop), and chapter text delimited as untrusted data, never instructions. Unknown attribution becomes a separate narration Segment with `containsVerbatimQuote: true` and the exact quote only; any source-supported lead-in is separate ordinary narration. The 35-word limit applies to condensed narration, not verbatim quotes. Do not modernise words or infer future events from the full-book Cast. One initial attempt plus at most two repair attempts.
4. **Validate** —
   - Zod parse and the schema/catalogue checks above; every dialogue speaker in Cast, first cold-open Segment is announcer, close includes the announcer tag, ordinary narration ≤35 words.
   - **Quote extraction:** deterministic parser with fixtures for nested quotations, apostrophes/contractions, repeated quotes, multi-paragraph quoted speech, letters/journals, straight and curly marks. Count maximal non-overlapping quote occurrences (do not double-count nested quotes). Ambiguous or unbalanced delimiters fail closed with diagnostics/manual-review state; never quietly infer a quote-free chapter. A quote inventory is not a perfect semantic speech detector; store parser policy/version and audit the demo fixtures.
   - **One fidelity metric:** `fidelity = matchedSpans / totalSpans`, or 1 for a successfully parsed genuinely quote-free source. Match complete normalised source quotes in script order across dialogue and narrator-quoted segments, allowing an exact quote to span adjacent speech segments. Use a maximum-cardinality ordered, non-overlapping occurrence alignment with deterministic tie-breaking; repeated occurrences consume separate intervals. Do not reuse one spoken quote to satisfy multiple source occurrences or count partial quotes. No lowercasing or arbitrary punctuation stripping.
   - **Reverse check:** every dialogue and marked narrator-quote text must also match source quote text in order, without invented words or duplicate replay. The 0.90 threshold tolerates missing source spans only, never invented dialogue. Report unmatched spans, reverse-check errors, source/script hashes and normaliser/parser versions. Unmarked ordinary narration, attribution and plot fidelity still need golden/manual review; this score does not prove semantic faithfulness.
   - On any validation error or `fidelity < 0.90`, retry with sanitised errors and missing quotes at most twice; if still invalid, mark chapter `failed` before TTS. Only a passing report advances to Render.
5. **Render** — hash a canonical JSON tuple of cache schema version, provider/model revision, voice ID, exact text submitted, delivery, synthesis settings and WAV format. Do not use the lossy fidelity normaliser as the cache key. Coalesce same-key requests; limit distinct calls (default concurrency 2), reserve budget, then synthesise. Write a unique same-directory `<key>.<job>.<nonce>.wav.tmp`, fully parse PCM WAV chunks, verify actual data length/frame alignment, non-zero duration, 24 kHz/mono/16-bit, flush and atomically rename to `<key>.wav`. Mark the DB complete only after publication. Validate existing cache files before reuse; ignore incomplete temp files and clean abandoned ones only after confirming no active writer. Test crashes before/after rename and before DB commit; an orphan valid WAV is reusable on resume.
6. **Mix** — construct one measured sample timeline (24 kHz) from decoded speech/SFX/music durations, explicit pauses and automatic gaps: 250 ms only between adjacent speech turns; 600 ms between Scenes replaces rather than stacks with a turn gap. Discrete foley/music occupy timeline duration in the MVP; only `scene.ambience` overlaps. Loop/trim/fade the bed to Scene duration, not the following transition gap; key `sidechaincompress` from a speech-only stem, including announcer/narrator where present. Compressor settings alone do not guarantee 12 dB attenuation: test the bed stem during active speech after attack, and use a speech-activity gain envelope if needed to guarantee the target. Assemble coldOpen/scenes/close; derive clean and AM variants from the same timeline. AM uses 300–3,400 Hz band-limiting, gentle saturation and low-level crackle. Master each with two-pass `loudnorm`, encode MP3 192k with AI-generated ID3 tags and chapter markers, then measure decoded MP3 true peak/LUFS and adjust headroom/re-encode if necessary. Produce VTT and marker times from that same timeline (including pauses, cues and gaps); verify MP3 encoder delay alignment and equal variant durations in the player.

## TTS Provider Interface

```ts
interface TtsProvider {
  id: string;
  voices(): Promise<Voice[]>;
  synthesize(req: { voiceId: string; text: string; delivery?: Delivery }): Promise<Buffer /* WAV 24k 16-bit mono */>;
  estimateCost(chars: number): number;
}
```

Providers: one cloud TTS provider (selected by env config), plus deterministic `StubProvider` (generates valid 24 kHz mono WAV tone/silence proportional to word count) for offline tests and CI.

## MCP Server — `sfx-library` (Kiro & Custom Agent Integration)

Tools:
- `search_sfx(query: string, limit?: number)` → `[{ id, title, tags, durationMs, licence }]`
- `get_sfx(id: string)` → file path, peak dB, loopable flag, CC0 attribution
- `list_music_cues()` → theme/sting/transition/bed assets
- `audit_script_sfx(scriptJson: string)` → shared schema/catalogue checks for referenced IDs, asset kinds, loopability and requested duration bounds; exact Scene timing is unverified until rendered durations exist

Backed by `assets/sfx/index.json` (CC0 or project-created assets with documented rights). Registered in `.kiro/settings/mcp.json` for Kiro IDE development, fixture authoring, hooks, and custom Kiro agents (`foley-curator` / `script-auditor`). At runtime, `packages/llm` and `packages/core` load `assets/sfx/index.json` directly in-process for fast, deterministic single-shot JSON adaptation.

## Player UI & Autoplay Gesture Handling

- **Valve-radio skeuomorph:** walnut cabinet, physical **POWER ON/OFF** toggle switch, glowing amber tuning dial, needle position = station; pure SVG + CSS.
- **Browser autoplay compliance:** clicking the physical **POWER** switch (or first dial drag/keypress) creates/resumes the Web Audio `AudioContext` inside the user gesture and plays a subtle 1.5 s tube-filament warmup hum before tuning into the active station.
- **Web Audio graph:** Episode `<audio>` MediaElementSource → station gain; procedural/looped pink-noise static buffer → bandpass → static gain; needle distance from nearest station frequency drives equal-power cross-fade between static and broadcast. Vintage AM toggle switches between the two mastered files while preserving playback position; live effects are not a substitute for verified export loudness.
- **"Warming up" stations:** pulse with a filament glow and display `rendered / total` segments in real time.
- **Accessibility:** dial is `role="slider"` (`ArrowLeft`/`ArrowRight` tune stations, `Space` toggles play/pause when player controls are focused; never intercept typing in forms) with `aria-valuetext` announcing station + chapter. Transcript stays navigable and searchable; provide opt-in polite cue announcements and avoid speaking the full transcript over the audio by default. Handle rejected `play()`/`resume()` promises with a visible retry control.

## Public-URL Cost & Abuse Protection

| Guardrail | Mechanism |
|---|---|
| Pre-rendered instant demos | *The Tell-Tale Heart* (or *House of Usher* excerpt) + *Dracula* Ch. 1 pre-seeded on `/data` — zero API cost for judges exploring the radio |
| Per-Book character budget | Configurable cap (default 60,000 chars); jobs pause as `over_budget` before exceeding |
| Global daily caps & rate limits | Before every paid request, transactionally reserve TTS characters or LLM input plus capped output tokens against UTC-day limits (`GLOBAL_DAILY_TTS_CHAR_LIMIT`, `GLOBAL_DAILY_LLM_TOKEN_LIMIT`). Include casting, repair attempts, retries and re-renders. Settle actual usage durably; retain conservative reservations for uncertain/billable failures instead of refunding blindly. Missing/zero budgets disable paid generation, not demo playback. |
| Judge passkey (optional) | `UPLOAD_PASSKEY` gates all custom-generation triggers, including cast edits/retries; apply server-side rate limits regardless, including failed passkey attempts. Never log passkeys or put them in URLs; share through private judging credentials. Per-user book budgets cannot raise operator caps. |

## Error Handling

| Failure | Behaviour |
|---|---|
| Bad / DRM / >20 MB EPUB | Reject at upload with human-readable reason; create no Book (Req 1.1, 1.2) |
| Adapter invalid JSON / fidelity < 0.90 | Retry ≤2 with validation errors + missing quotes; then mark chapter `failed` (Req 4.3) |
| Interrupted / corrupt TTS write | Abandoned `.tmp` files discarded only after checking writer ownership; cache validator rejects 0-byte/truncated WAVs; atomic rename only on valid WAV (Req 5.2) |
| TTS API error | 3 retries with exponential backoff; mark only failing Segment `failed`, keep completed ones (Req 5.3) |
| Per-book or daily budget exceeded | Job paused `over_budget` with clear UI banner; demo playback unaffected (Req 8.2) |
| Worker restart | Expired job leases reclaimed with ownership tokens; stale workers are fenced from publishing DB state/episode outputs. Heartbeat long calls and retain uncertain budget reservations; pipeline resumes from validated cache / last completed step (Req 8.1) |

## Testing Strategy (Including Property-Based Testing)

- **Property-Based Tests (`fast-check` in Vitest):**
  1. *Splitter invariants (`packages/ingest`):* for arbitrary chapter strings (0–30,000 words) with random paragraphs and `* * *` scene breaks, every output part is ≤8,000 words and concatenating parts preserves the exact canonical non-whitespace token sequence; explicitly generate oversized paragraphs and a single long token.
  2. *Inline XHTML & quote normalisation idempotence (`packages/ingest`):* `normaliseText(normaliseText(x)) === normaliseText(x)` and inline tag wrapping (`<em>w</em>ord`) never introduces internal whitespace (`"word"`).
  3. *Casting determinism (`packages/core`):* shuffling chapter discovery order for the same character set produces the exact same `character → voiceId` assignment and never assigns `Announcer` or `Narrator` voices to characters.
  4. *Quote-fidelity bounds (`packages/core`):* for any generated text containing a subset of source quotes, `0 <= fidelity <= 1`, `fidelity === 1` when all source quotes appear verbatim in order, and removing a source-quote occurrence from an otherwise valid ordered output cannot increase fidelity against a fixed source inventory (ties are allowed); do not assert this for arbitrary segment deletion that can concatenate formerly separated fragments. Add repeated, reordered, invented, nested, split-across-segments and quote-free/unbalanced regression fixtures; flags never bypass the reverse check.
- **Unit tests:** Zod schema/catalogue kinds, full WAV/truncation validator, request-sensitive cache keys, lease recovery and transactional reservations. Concurrent jobs must not overshoot caps; passkey/rate-limit checks cover every paid route. Test corrupt ZIP/path traversal/resource bounds and cast edits invalidating episode timelines.
- **Golden tests:** 2-page Gothic fixture chapter → snapshot-verified Script JSON & fidelity check with mocked LLM.
- **Integration:** end-to-end pipeline on fixture with `StubProvider`; assert MP3 + VTT exist, scene bed ducking graph builds cleanly, VTT cue count matches speech segments, and interrupted `.tmp` cache files self-heal.
- **Audio checks:** decode both final MP3 variants; measure −16 ±1 LUFS and true peak ≤ −1.0 dBTP with `ffmpeg -af ebur128=peak=true`. Verify bed gain reduction and VTT/marker timing separately. Use non-silent fixtures; silence has undefined integrated loudness.
- **E2E (Playwright):** load player, flip POWER switch, tune dial across pre-rendered demo stations, upload fixture EPUB with `StubProvider`, verify keyboard navigation, navigable transcript and opt-in ARIA cue announcements, and AI disclosure labels.

## Kiro Usage Plan (Evidence to Capture, Not Completed Claims)

- **Specs:** EARS `requirements.md` → `design.md` → requirement-traced `tasks.md`.
- **Steering:** `product.md` & `tech.md` (always included) + `radio-voice.md` (`fileMatch` on `packages/llm/**`).
- **Property-Based Testing (PBT):** `fast-check` suites verifying ingestion token preservation, normalisation idempotence, casting determinism, and fidelity monotonicity directly from spec properties.
- **Hooks:**
  - On save of `packages/core/src/schema.ts` → regenerate JSON Schema and run `packages/core` unit + PBT suites.
  - On save/create in `fixtures/scripts/*.json` → run `audit_script_sfx` + dialogue-fidelity validator.
- **MCP:** `mcp/sfx-library` registered in `.kiro/settings/mcp.json` for CC0 asset discovery and script foley auditing.
- **Custom Agent:** create `script-auditor` using the installed Kiro version's supported agent UI/schema, combining explicit `radio-voice.md` context with `sfx-library` MCP. Commit the configuration at the path Kiro actually generates; no guessed agent extension/schema is supplied here. Capture a real run. If unavailable in that version, record the limitation instead of claiming usage.
