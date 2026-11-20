# Requirements Document — Midnight Radio

## Introduction

Midnight Radio resurrects the golden-age radio drama (1930s–1950s). A listener supplies a DRM-free EPUB and receives a complete radio episode for each chapter: an announcer cold open, a consistent cast of character voices, narration, sound effects, scene-scoped ambience beds, musical stings, and a "tune in next week" cliffhanger close. The app is played through a vintage valve-radio interface where turning the dial changes chapters.

Target category: **Resurrection** (Kiroween 2026). Demo content: public-domain Gothic fiction (*The Tell-Tale Heart* / *The Fall of the House of Usher* for instant high-density demo playback, plus *Dracula* for multi-chapter cast continuity).

### Glossary

- **Book** — one uploaded or bundled EPUB and everything derived from it.
- **Cast** — the persistent mapping of characters to voices for one Book.
- **Scene** — a contiguous dramatic unit inside a Script with optional background ambience/music bed.
- **Script** — the structured, validated radio adaptation of one chapter (JSON, see design).
- **Segment** — one cue in a Scene, cold open, or close (`announcer`, `narration`, `dialogue`, `sfx`, `music`, or `pause`).
- **Episode** — the rendered, mixed audio for one chapter.
- **Render cache** — TTS audio stored atomically by content hash so unchanged speech Segments are never re-synthesised.

## Requirements

### Requirement 1 — Book ingestion

**User Story:** As a listener, I want to upload an EPUB, so that I can hear it as a radio drama.

#### Acceptance Criteria

1. WHERE generation is enabled (local runs; see 8.5), WHEN a user uploads a file with a `.epub` extension of at most 20 MB THE SYSTEM SHALL parse it and list its chapters with title and approximate word count.
2. IF the EPUB is DRM-protected, malformed, or contains no readable text THEN THE SYSTEM SHALL reject it with a specific, human-readable reason and create no Book.
3. THE SYSTEM SHALL strip front matter, tables of contents, footnote markers, and images before adaptation, while preserving inline character adjacency across inline XHTML tags (`<em>`, `<span>`, drop-caps) and introducing separators at block boundaries and explicit `<br>`/`<hr>` breaks without deleting existing text-node whitespace.
4. THE SYSTEM SHALL preserve extracted source text and paragraph boundaries, extract quote spans before folding directional quotation marks, and apply the same versioned typography/whitespace normaliser to source and Script for comparison; case, words, and punctuation SHALL NOT be deleted to improve fidelity.
5. WHEN a chapter exceeds 8,000 words THE SYSTEM SHALL split it at scene or paragraph boundaries, falling back to sentence/word boundaries for an oversized paragraph, into parts of at most 8,000 words without dropping or reordering canonical non-whitespace tokens, and label them "Part 1 of N".
6. THE SYSTEM SHALL bundle public-domain source fixtures and at least two pre-rendered demo episodes (a short Gothic work or clearly labelled contiguous excerpt, plus *Dracula* Chapter 1), with transcripts and attribution, so tuning works without a paid generation job. Select a source passage containing actual dialogue for a multi-voice showcase; do not invent lines or sounds to improve the demo.

### Requirement 2 — Casting

**User Story:** As a listener, I want each character to keep the same voice across the whole book, so that I can follow who is speaking.

#### Acceptance Criteria

1. WHEN a Book is ingested THE SYSTEM SHALL extract a canonical character list (name, aliases, gender presentation if stated, age band, one-line description) from the full text before any chapter is adapted.
2. THE SYSTEM SHALL deterministically assign every character a distinct voice from a pinned voice catalogue (invariant to processing order for the same frozen character inventory) and persist the Cast with the Book; IF available voices are insufficient THEN casting SHALL pause with a clear error rather than silently share voices.
3. WHILE a Book has a persisted Cast THE SYSTEM SHALL reuse that Cast for every chapter and SHALL NOT reassign a voice automatically.
4. WHEN a chapter introduces a character not in the Cast THE SYSTEM SHALL add the character with an unused, non-reserved voice and record the addition, or pause if none is available; existing assignments SHALL remain unchanged.
5. WHERE the user edits the Cast THE SYSTEM SHALL invalidate and re-render only the Segments spoken by the changed characters, then re-mix affected Episodes and rebuild their transcripts/markers from the new durations. Voice edits SHALL retain distinct voices and reserved-voice exclusion.
6. THE SYSTEM SHALL reserve one fixed voice for the Announcer and one for the Narrator, never assigned to a character.

### Requirement 3 — Radio adaptation

**User Story:** As a listener, I want the chapter performed like a 1940s radio play, not read like an audiobook.

#### Acceptance Criteria

1. WHEN a chapter is adapted THE SYSTEM SHALL produce a scene-structured Script that validates against the Script JSON schema, reading curated sound-effect IDs directly from `assets/sfx/index.json` without runtime stdio tool loops.
2. THE SYSTEM SHALL preserve quoted dialogue from the source verbatim, attributed to the speaking character.
3. THE SYSTEM SHALL condense non-dialogue prose into Narrator lines of at most 35 words each, keeping plot events in source order.
4. THE SYSTEM SHALL open each Episode with an Announcer cold open (series title, episode number, chapter title) and close it with a cliffhanger tag ("Tune in next time…") that does not reveal events from later chapters.
5. THE SYSTEM SHALL insert discrete `sfx` cues and scene-level `ambience` beds only for sounds stated or clearly implied by the text, each referencing an existing sound-library ID in `assets/sfx/index.json`.
6. IF the adapter cannot attribute a quoted dialogue span with confidence THEN THE SYSTEM SHALL assign that text verbatim to a separate Narrator Segment marked `containsVerbatimQuote: true`, without an invented speaker attribution. Any source-supported lead-in SHALL be a separate ordinary narration Segment; the 35-word condensation limit SHALL NOT truncate quoted text.
7. THE SYSTEM SHALL NOT invent characters, plot events, or dialogue absent from the source.

### Requirement 4 — Script validation (quality gate)

**User Story:** As the builder, I want every Script checked before audio is generated, so that broken scripts never waste TTS render time.

#### Acceptance Criteria

1. WHEN a Script is produced THE SYSTEM SHALL validate: schema, every `speaker` exists in the Cast, every `sfxId` and `scene.ambience.id` resolves to the correct asset kind in `assets/sfx/index.json`, every discrete music cue resolves to a pinned music asset, no empty text, valid bounded durations/gains, and Announcer cold open and close are present.
2. THE SYSTEM SHALL compute `fidelity = matchedSpeechSpans / totalSpeechSpans` using deterministic source quote extraction and ordered, non-overlapping normalised verbatim matches across `dialogue` and narrator-quoted Segments; each source occurrence counts once, with nested quotes not double-counted. Source quotes are classified deterministically, under the versioned parser policy, as speech or as terms (words quoted for emphasis or as names, e.g. “robber steak”); only speech is scored, terms are still aligned and reported. Every such output Segment SHALL also match source text in order (no invented or duplicated dialogue). Set fidelity to 1 only for a successfully parsed source with no speech quotes; ambiguous/unbalanced quoting SHALL fail validation rather than be treated as zero quotes. No LLM-generated character offsets are accepted.
3. IF validation fails or dialogue fidelity is below 0.90 THEN THE SYSTEM SHALL re-run adaptation with the specific validation errors and missing dialogue spans as feedback, at most 2 times, and SHALL mark the chapter failed after that rather than render it.
4. THE SYSTEM SHALL store the validation report alongside the Script.

### Requirement 5 — Voice rendering

**User Story:** As a listener, I want natural, distinct voices.

#### Acceptance Criteria

1. THE SYSTEM SHALL synthesise each speech Segment with the voice assigned in the Cast through a pluggable TTS provider interface.
2. THE SYSTEM SHALL key the Render cache on the versioned synthesis request `(provider/model version, voice ID, exact submitted text, delivery hint, synthesis settings, output format)`, reuse only validated cached audio, and publish via a unique same-directory temporary file plus full PCM WAV length/format/non-zero frame validation and atomic rename. Concurrent identical requests SHALL be coalesced; incomplete files SHALL never count as cache hits.
3. IF a TTS call fails THEN THE SYSTEM SHALL retry up to 3 times with exponential backoff and then mark only that Segment failed, without discarding completed Segments.
4. THE SYSTEM SHALL synthesise speech with a locally run Qwen3-TTS model and SHALL NOT call a cloud TTS service. It SHALL also provide an offline `StubProvider` (deterministic tone/silence of proportional length) for tests and CI.
5. THE SYSTEM SHALL build its pinned voice catalogue offline with Qwen3-TTS VoiceDesign from written voice descriptions (no cloning of real people), storing for each voice its description, gender presentation, age band, reference clip, clip transcript and content hash.
6. THE SYSTEM SHALL report a chapter's character count and estimated render time before rendering starts.

### Requirement 6 — Mixing and the "radio sound"

**User Story:** As a listener, I want it to sound like an old broadcast.

#### Acceptance Criteria

1. WHEN all Segments of a chapter are rendered THE SYSTEM SHALL assemble each Scene in Script order with configured gaps (default 250 ms between turns, 600 ms at scene transitions).
2. WHEN a Scene declares `scene.ambience` (one SFX or music bed) THE SYSTEM SHALL loop/trim it across that Scene's measured duration, fade it at scene boundaries, and reduce its gain by at least 12 dB during speech after the documented attack interval. Sidechain settings SHALL be measured, not assumed to guarantee this reduction.
3. WHERE "Vintage AM" mode is enabled THE SYSTEM SHALL apply a band-limit (≈300–3,400 Hz), light warm saturation, and a low-level crackle bed; WHERE it is disabled THE SYSTEM SHALL output the clean mix.
4. THE SYSTEM SHALL loudness-normalise each Episode to −16 LUFS integrated (±1 LU) with true peak ≤ −1.0 dBTP and export MP3; both clean and Vintage AM files SHALL pass measurement after MP3 decoding.
5. THE SYSTEM SHALL emit chapter markers and a transcript (WebVTT) aligned to cumulative Segment start times.

### Requirement 7 — Vintage radio player

**User Story:** As a listener, I want to tune into chapters on an old radio.

#### Acceptance Criteria

1. THE SYSTEM SHALL present a valve-radio interface with a physical power toggle switch (which unlocks/resumes browser `AudioContext` on user gesture with a tube warmup hum) and a tuning dial on which each rendered Episode is a station.
2. WHEN the user turns the dial between stations THE SYSTEM SHALL play static, and WHEN it lands on a station THE SYSTEM SHALL cross-fade the Episode in.
3. THE SYSTEM SHALL show a "now playing" card with speaker name and the current transcript line.
4. THE SYSTEM SHALL be operable by keyboard (Space toggles play/pause and Arrow keys tune stations while player controls are focused, without intercepting form typing), expose a navigable transcript, and offer opt-in polite ARIA cue announcements rather than reading over playback by default.
5. WHEN a chapter is still rendering THE SYSTEM SHALL show its station as "warming up" with progress (`Segments rendered / total`).

### Requirement 8 — Jobs, cost, and public-deployment safety

**User Story:** As the operator, I want rendering to be resumable, bounded in cost, and safe to expose on a public URL for hackathon judges.

#### Acceptance Criteria

1. THE SYSTEM SHALL process adaptation and rendering as resumable jobs whose state survives a server restart on persistent storage.
2. THE SYSTEM SHALL enforce an operator-controlled per-Book TTS character budget and global daily TTS-character and LLM-token caps using atomic reservations before every LLM call and TTS render, including casting, adaptation, retries, and re-renders. All generation-triggering endpoints SHALL be rate-limited; an optional judge passkey SHALL protect custom generation, not just uploads, while demo playback stays public. A user-selected budget SHALL NOT raise operator caps.
3. THE SYSTEM SHALL NOT log or persist API keys, and SHALL read them only from environment variables.
4. THE SYSTEM SHALL record per-chapter LLM tokens, TTS characters, and wall time.
5. WHERE generation is disabled (the default, and always on the live deployment) THE SYSTEM SHALL serve only the pre-rendered demo Episodes, hide upload and cast editing, and refuse every generation-triggering request. Generation SHALL run only when explicitly enabled on a machine running the local audio models.

### Requirement 9 — Content and rights

#### Acceptance Criteria

1. THE SYSTEM SHALL display a notice that users must have the right to adapt uploaded content.
2. THE SYSTEM SHALL use only sound effects and music licensed CC0 or created for the project (including foley generated offline through the documented sound-effect service API, `docs/sfx-service-api.md`, by a model whose output licence permits redistribution; reference model MOSS-SoundEffect v2.0, Apache-2.0), and SHALL list each asset's source and licence in `ATTRIBUTION.md`. For generated foley the record SHALL include the model, revision and output licence the service reported.
3. THE SYSTEM SHALL label every Episode as AI-generated in its ID3 metadata and the player UI.
