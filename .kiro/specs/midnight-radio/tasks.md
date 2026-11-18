# Implementation Plan — Midnight Radio

- [x] 1. Scaffold monorepo and core scene-based Script schema
  - Create pnpm workspace (`Node 24`, strict TypeScript) with `apps/web`, `apps/worker`, `packages/{core,ingest,llm,tts,mix}`, `mcp/sfx-library`
  - Implement strict Zod boundary checks (unknown fields, non-empty text/scenes, unique scene IDs, bounded durations/gains, asset kinds) and define schemas for `Script`, `Scene` (with scene-scoped `SceneBed`), and `Segment` (without brittle LLM `sourceSpan` offsets), plus exported JSON Schema generator
  - Configure Vitest + `fast-check` across workspace packages
  - _Requirements: 3.1, 4.1_

- [ ] 2. SQLite persistence, resumable job queue, and spend guardrails
  - [x] 2.1 Migrations for `books`, `chapters` (with `canonical_text`), `cast_members`, `scripts`, `segments`, `episodes`, `jobs` (with `lease_until`), `usage` (with `day_utc`), and durable `budget_reservations`; include source quote inventory and parser/normaliser versions
  - [ ] 2.2 Resumable job runner (atomic claim, lease heartbeat, ownership fencing before publication, crash recovery on restart)
    - Done: `JobQueue` and `runOnce`/`runWorker` in `apps/worker/src/jobs/` (atomic claim, heartbeats, DB-write fencing, lease-expiry reclaim, multi-process claim test)
    - Remaining: worker entrypoint that opens the `/data` database, runs `runWorker` and turns SIGTERM/SIGINT into the abort signal. Fencing of file outputs (episode MP3/VTT publication) lands with tasks 8–9
  - [ ] 2.3 Operator-controlled per-Book TTS budget + global daily TTS/LLM caps (`GLOBAL_DAILY_TTS_CHAR_LIMIT`, `GLOBAL_DAILY_LLM_TOKEN_LIMIT`); transactional reservations/settlement for every paid call, retries and uncertain outcomes; rate-limit all generation routes and optionally gate with `UPLOAD_PASSKEY`; missing/zero caps disable paid calls
    - Done: `BudgetLedger` in `packages/db` (reservations, fail-closed settlement, overrun/estimated flags, uncertain outcomes, `BOOK_TTS_CHAR_LIMIT` ceiling) and `GenerationGuard` in `apps/web/src/server/guards.ts` (rate limit, passkey, lockout, IPv6 /64 keys)
    - Remaining: call the ledger from every paid LLM/TTS call (tasks 4, 6, 8) and apply the guard to every generation route with a trusted client IP (task 11), with a test covering each route
  - _Requirements: 8.1, 8.2, 8.4_

- [ ] 3. EPUB ingestion and property-based parser verification
  - [ ] 3.1 Parse OPF spine, strip nav/TOC/front matter/footnotes/images, and implement inline-safe XHTML → text extraction (preserve adjacency across `<em>`/`<span>`/drop-caps; preserve existing whitespace and break at block tags plus `<br>`/`<hr>`)
  - [ ] 3.2 Versioned typography/quote comparison normaliser; preserve source layout and extract quotes before folding directional marks. Reject DRM/malformed/empty/>20 MB files, ZIP traversal/bombs and external entities; never fetch external EPUB resources
  - [ ] 3.3 Scene-break detection before whitespace folding and >8,000-word splitter ("Part 1 of N"), with sentence/word fallback for oversized paragraphs and source-mapped quote fragments at part boundaries
  - [ ] 3.4 Property-based tests (`fast-check`): splitter ≤8,000-word bound + exact non-whitespace token preservation; normalisation idempotence + inline-tag adjacency
  - [ ] 3.5 Bundle public-domain Gothic fixtures (*The Tell-Tale Heart* / *House of Usher* for atmosphere + *Dracula* Ch. 1 for demo playback; add a source-supported dialogue passage and at least two chapters sharing a character for continuity tests)
  - _Requirements: 1.1–1.6_

- [ ] 4. Deterministic casting
  - [ ] 4.1 Map-reduce character extraction over `canonical_text` (names, aliases, gender presentation, age band, description)
  - [ ] 4.2 Order-invariant voice assignment from the same frozen inventory and pinned voice catalogue; reserved `Announcer`/`Narrator` voices, stable tie-breaks, pause on voice exhaustion
  - [ ] 4.3 Add-new-character flow preserving existing voices; enforce unique/non-reserved voices on edits; targeted speech invalidation followed by episode re-mix and VTT/marker regeneration
  - [ ] 4.4 Property-based test (`fast-check`): voice assignment invariance under permutations of the same frozen inventory (not repeat LLM extractions) and reserved-voice exclusion
  - _Requirements: 2.1–2.6_

- [ ] 5. `sfx-library` MCP server and CC0 foley pack
  - [ ] 5.1 Curate 30–50 CC0 Gothic radio foley & music cues (thunder, rain bed, carriage wheels, heavy door creak, hearth fire, footsteps, clock chime, theme/sting/transition) into `assets/sfx/index.json` + `ATTRIBUTION.md`
  - [ ] 5.2 Implement stdio MCP server (`search_sfx`, `get_sfx`, `list_music_cues`, `audit_script_sfx`); register in `.kiro/settings/mcp.json` and create `script-auditor` via the installed Kiro version's supported UI/schema; record limitations if unavailable. Use the same versioned catalogue, pinned cue map and kind/loopability checks at runtime and in MCP
  - _Requirements: 3.5, 9.2_

- [ ] 6. Single-pass radio adaptation
  - [ ] 6.1 Adapter prompt combining `radio-voice.md` steering, chapter-local view of persisted `Cast` (exclude future plot descriptions), in-process `assets/sfx/index.json` catalogue (no runtime stdio MCP loop), and `canonical_text`
  - [ ] 6.2 Structured JSON output enforcing `coldOpen` announcer, `scenes` with optional `SceneBed` ambience, ≤35-word present-tense condensed narration (verbatim quotes exempt), and spoiler-free cliffhanger `close`
  - [ ] 6.3 Low-confidence speaker fallback: assign quoted text *verbatim* to `Narrator` (`containsVerbatimQuote: true`) containing only the quote; place any source-supported lead-in in a separate unmarked segment
  - _Requirements: 3.1–3.7_

- [ ] 7. Deterministic validation gate
  - [ ] 7.1 Referential validator (Cast speakers, `assets/sfx/index.json` IDs, cold open/close rules) + source quote parser with ambiguity diagnostics, ordered non-overlapping occurrence alignment and reverse checks against invented/duplicated speech; store hashes/parser versions. Preserve quote fragments across part boundaries
  - [ ] 7.2 Retry-with-feedback loop (≤2 retries passing exact schema errors + unmatched source quotes) and fail-closed `failed` state
  - [ ] 7.3 Unit + `fast-check` property tests for quote extraction and ordered alignment (`0 <= fidelity <= 1`, all quotes in order = `1.0`); repeated/nested/reordered/invented quotes, split segments, part boundaries, unbalanced and genuinely quote-free fixtures
  - _Requirements: 4.1–4.4_

- [ ] 8. TTS rendering with atomic cache
  - [ ] 8.1 `TtsProvider` interface, offline `StubProvider` (valid 24 kHz 16-bit mono WAV proportional to word count), and cloud TTS provider
  - [ ] 8.2 Atomic content-hash render cache: versioned exact-request cache keys, unique same-directory temp WAV, full PCM format/data-length/frame validation + flush + atomic rename, validate cache hits, coalesce identical requests, bounded concurrency (default 2); crash tests around rename/DB commit
  - [ ] 8.3 Exponential-backoff retries (≤3), isolated per-segment failure handling, pre-render character/cost estimate, and zero secret logging
  - _Requirements: 5.1–5.5, 8.2, 8.3_

- [ ] 9. Scene-based ffmpeg mixing & loudness mastering
  - [ ] 9.1 Single `ffmpeg` wrapper in `packages/mix` (logs full filter graph on error); sample-based timeline with 250 ms only between adjacent speech turns; 600 ms scene transitions replace rather than stack with turn gaps; discrete cues occupy time
  - [ ] 9.2 Scene-scoped `SceneBed` looping/trimming (`aloop` + `atrim` + `afade`) and measured ≥12 dB speech-keyed ducking after attack; speech-activity gain envelope fallback if compression alone is insufficient
  - [ ] 9.3 Vintage AM broadcast chain (`highpass=300`, `lowpass=3400`, soft saturation, low-level crackle bed) + clean mix output
  - [ ] 9.4 Two-pass `loudnorm` (−16 LUFS ±1 LU, TP ≤ −1.0 dBTP), 192 kbps MP3 export with AI-disclosure ID3 tags + chapter markers, and cumulative WebVTT transcript
  - [ ] 9.5 Integration with non-silent `StubProvider` fixtures: measure decoded MP3 LUFS/true peak for both variants, actual bed attenuation, equal duration and encoder-delay-aware VTT/marker alignment
  - _Requirements: 6.1–6.5, 9.3_

- [ ] 10. Vintage valve-radio player UI
  - [ ] 10.1 Walnut & glowing-amber SVG/CSS valve-radio cabinet, tuning dial (`role="slider"`), and physical **POWER** switch that unlocks browser `AudioContext` on user gesture with tube warmup hum
  - [ ] 10.2 Web Audio API equal-power static ↔ station cross-fade driven by dial distance, plus live Vintage AM / Clean toggle
  - [ ] 10.3 Now-playing speaker card + synced navigable WebVTT transcript panel with opt-in polite cue announcements
  - [ ] 10.4 Full keyboard navigation (`Space` play/pause, `ArrowLeft`/`ArrowRight` station tuning) when player controls are focused, no interception of form typing, opt-in screen-reader cue announcements and visible playback retry on rejected browser promises
  - [ ] 10.5 Pulsing filament "warming up" indicator showing `rendered / total` segments for in-progress chapters
  - _Requirements: 7.1–7.5_

- [ ] 11. Upload flow, rights/AI notices, and cast editor
  - Upload dropzone (≤20 MB `.epub` check, optional judge passkey prompt, rights notice, per-Book budget control), cast voice editor with targeted re-render, and visible AI-generated badge
  - _Requirements: 2.5, 8.2, 9.1, 9.3_

- [ ] 12. Pre-rendered demos, single-container deploy, E2E, and Kiroween submission
  - [ ] 12.1 Playwright E2E suite (`StubProvider`): power-on gesture, instant demo tuning, fixture EPUB upload, keyboard controls, and transcript alignment and opt-in accessibility assertions
  - [ ] 12.2 Pre-render *The Tell-Tale Heart* (or *House of Usher* opening) + *Dracula* Ch. 1 with real cloud TTS as checksum-pinned, idempotently seeded demos (no paid boot calls); target sound within 5 seconds after a user gesture on a documented connection. Use an actual dialogue passage for multi-voice demonstrations
  - [ ] 12.3 `Dockerfile` + persistent `/data` volume config (Fly.io / Railway / VPS) running one replica with `apps/web` + `apps/worker` + `ffmpeg`, supervised shutdown/restarts, readiness checks and backup; prove restart/redeploy persistence; verify `.kiro/` is tracked in git (NOT in `.gitignore`) and add MIT/Apache-2.0 `LICENSE`
  - [ ] 12.4 Create hooks for schema/fixture audits in installed Kiro; capture actual Specs, Steering, PBT, Hooks, MCP and supported Custom Agent runs. Prepare README, architecture diagram, demo video and optional blog/social drafts; recheck current official submission rules before publishing. Never claim planned tools were used
  - _Requirements: 1.6, 8.1–8.4, 9.1–9.3_
