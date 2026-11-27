import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only. Never edit a released migration; add a new one instead.
 * Timestamps are Unix epoch milliseconds (INTEGER). `day_utc` is `YYYY-MM-DD`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: /* sql */ `
CREATE TABLE books (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  author        TEXT,
  source_hash   TEXT NOT NULL,
  char_budget   INTEGER NOT NULL DEFAULT 60000 CHECK (char_budget >= 0),
  status        TEXT NOT NULL,
  is_demo       INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at    INTEGER NOT NULL
);

-- One row per adaptation unit. Chapters over 8,000 words become parts
-- (part = 1..part_count) sharing the same idx, so provenance to the parent survives.
CREATE TABLE chapters (
  id                      TEXT PRIMARY KEY,
  book_id                 TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx                     INTEGER NOT NULL CHECK (idx >= 0),
  title                   TEXT NOT NULL,
  part                    INTEGER NOT NULL DEFAULT 1 CHECK (part >= 1),
  part_count              INTEGER NOT NULL DEFAULT 1 CHECK (part_count >= part),
  source_text             TEXT NOT NULL,
  canonical_text          TEXT NOT NULL,
  -- Source quote inventory: deterministic spans incl. parent quote IDs and continuation flags.
  quote_spans_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(quote_spans_json)),
  quote_parse_status      TEXT NOT NULL DEFAULT 'pending'
                          CHECK (quote_parse_status IN ('pending', 'ok', 'ambiguous')),
  quote_diagnostics_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(quote_diagnostics_json)),
  quote_parser_version    TEXT,
  normaliser_version      TEXT,
  word_count              INTEGER NOT NULL CHECK (word_count >= 0),
  status                  TEXT NOT NULL,
  UNIQUE (book_id, idx, part)
);

CREATE TABLE cast_members (
  id                TEXT PRIMARY KEY,
  book_id           TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  aliases_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  role              TEXT NOT NULL,
  gender_hint       TEXT,
  age_band          TEXT,
  voice_id          TEXT,
  description       TEXT,
  added_in_chapter  TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  UNIQUE (book_id, name)
);
-- Distinct voices per Book (Announcer/Narrator reservation is enforced in code).
CREATE UNIQUE INDEX cast_members_book_voice ON cast_members(book_id, voice_id)
  WHERE voice_id IS NOT NULL;

CREATE TABLE scripts (
  id               TEXT PRIMARY KEY,
  chapter_id       TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL CHECK (version >= 1),
  json             TEXT NOT NULL CHECK (json_valid(json)),
  -- Report incl. unmatched spans, reverse-check errors, source/script hashes, parser/normaliser versions.
  validation_json  TEXT CHECK (validation_json IS NULL OR json_valid(validation_json)),
  fidelity         REAL CHECK (fidelity IS NULL OR (fidelity >= 0 AND fidelity <= 1)),
  status           TEXT NOT NULL,
  UNIQUE (chapter_id, version)
);

CREATE TABLE segments (
  id                       TEXT PRIMARY KEY,
  script_id                TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  section                  TEXT NOT NULL CHECK (section IN ('coldOpen', 'scenes', 'close')),
  scene_idx                INTEGER CHECK (scene_idx IS NULL OR scene_idx >= 0),
  idx                      INTEGER NOT NULL CHECK (idx >= 0),
  kind                     TEXT NOT NULL
                           CHECK (kind IN ('announcer', 'narration', 'dialogue', 'sfx', 'music', 'pause')),
  speaker                  TEXT,
  text                     TEXT,
  contains_verbatim_quote  INTEGER NOT NULL DEFAULT 0 CHECK (contains_verbatim_quote IN (0, 1)),
  sfx_id                   TEXT,
  delivery                 TEXT,
  cache_key                TEXT,
  audio_path               TEXT,
  duration_ms              INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status                   TEXT NOT NULL,
  CHECK ((section = 'scenes') = (scene_idx IS NOT NULL))
);
CREATE UNIQUE INDEX segments_order ON segments(script_id, section, IFNULL(scene_idx, -1), idx);
CREATE INDEX segments_cache_key ON segments(cache_key) WHERE cache_key IS NOT NULL;

CREATE TABLE episodes (
  id              TEXT PRIMARY KEY,
  chapter_id      TEXT NOT NULL UNIQUE REFERENCES chapters(id) ON DELETE CASCADE,
  mp3_path        TEXT NOT NULL,
  clean_mp3_path  TEXT NOT NULL,
  vtt_path        TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL CHECK (duration_ms > 0),
  lufs            REAL,
  true_peak       REAL
);

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'over_budget')),
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until  INTEGER,
  lease_token  TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX jobs_claimable ON jobs(state, lease_until);
-- At most one active job per (kind, ref_id); identical requests coalesce onto it.
CREATE UNIQUE INDEX jobs_active_unique ON jobs(kind, ref_id) WHERE state IN ('queued', 'running');

-- chapter_id is NULL for book-wide work such as casting.
CREATE TABLE usage (
  id          TEXT PRIMARY KEY,
  day_utc     TEXT NOT NULL CHECK (day_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  book_id     TEXT REFERENCES books(id) ON DELETE SET NULL,
  chapter_id  TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  llm_in      INTEGER NOT NULL DEFAULT 0 CHECK (llm_in >= 0),
  llm_out     INTEGER NOT NULL DEFAULT 0 CHECK (llm_out >= 0),
  tts_chars   INTEGER NOT NULL DEFAULT 0 CHECK (tts_chars >= 0),
  wall_ms     INTEGER NOT NULL DEFAULT 0 CHECK (wall_ms >= 0)
);
CREATE INDEX usage_day ON usage(day_utc);
CREATE INDEX usage_chapter ON usage(chapter_id);

-- Durable reservation/settlement for every paid call. 'uncertain' keeps the conservative
-- reservation counted against caps (e.g. timeout after the request may have been billed).
-- Book/chapter links are SET NULL on delete so spend history is never lost.
CREATE TABLE budget_reservations (
  id                   TEXT PRIMARY KEY,
  job_id               TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  day_utc              TEXT NOT NULL CHECK (day_utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  book_id              TEXT REFERENCES books(id) ON DELETE SET NULL,
  chapter_id           TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  provider_request_id  TEXT,
  llm_tokens           INTEGER NOT NULL DEFAULT 0 CHECK (llm_tokens >= 0),
  tts_chars            INTEGER NOT NULL DEFAULT 0 CHECK (tts_chars >= 0),
  actual_llm_tokens    INTEGER CHECK (actual_llm_tokens IS NULL OR actual_llm_tokens >= 0),
  actual_tts_chars     INTEGER CHECK (actual_tts_chars IS NULL OR actual_tts_chars >= 0),
  state                TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'uncertain')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  CHECK (state != 'settled' OR (actual_llm_tokens IS NOT NULL AND actual_tts_chars IS NOT NULL))
);
CREATE INDEX budget_reservations_day ON budget_reservations(day_utc, state);
CREATE INDEX budget_reservations_book ON budget_reservations(book_id, state);
`,
  },
  {
    version: 2,
    name: "budget overrun and estimated-usage flags; usage per reservation",
    sql: /* sql */ `
-- overrun: settled actual usage exceeded the reservation (e.g. a low LLM input-token estimate).
ALTER TABLE budget_reservations ADD COLUMN overrun INTEGER NOT NULL DEFAULT 0 CHECK (overrun IN (0, 1));
-- usage_estimated: the provider did not report usage, so the reserved amount was recorded instead.
ALTER TABLE budget_reservations ADD COLUMN usage_estimated INTEGER NOT NULL DEFAULT 0 CHECK (usage_estimated IN (0, 1));
-- One usage row per reservation, so an uncertain outcome can be recorded and later replaced by settlement.
ALTER TABLE usage ADD COLUMN reservation_id TEXT REFERENCES budget_reservations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX usage_reservation ON usage(reservation_id);
`,
  },
  {
    version: 3,
    name: "cast: pinned voice catalogue and member details",
    sql: /* sql */ `
-- A Book's Cast is frozen once its catalogue pin is set; later changes are explicit edits.
ALTER TABLE books ADD COLUMN voice_catalogue_id TEXT;
ALTER TABLE books ADD COLUMN voice_catalogue_hash TEXT;
-- role: 'character' | 'announcer' | 'narrator' (checked in code). The reserved roles are rows too,
-- so the (book_id, voice_id) unique index also keeps their voices away from characters.
ALTER TABLE cast_members ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 0 CHECK (mention_count >= 0);
ALTER TABLE cast_members ADD COLUMN speaks INTEGER NOT NULL DEFAULT 0 CHECK (speaks IN (0, 1));
ALTER TABLE cast_members ADD COLUMN voice_fit TEXT CHECK (voice_fit IS NULL OR voice_fit IN ('good', 'fair', 'poor'));
-- At most one Announcer and one Narrator per Book.
CREATE UNIQUE INDEX cast_members_reserved_role ON cast_members(book_id, role) WHERE role IN ('announcer', 'narrator');
`,
  },
  {
    version: 4,
    name: "stale episodes after cast edits",
    sql: /* sql */ `
-- stale: some of the episode's speech was invalidated (a Cast voice edit), so its audio, VTT and
-- chapter markers are out of date until the episode is re-mixed from the new durations.
ALTER TABLE episodes ADD COLUMN stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1));
CREATE INDEX segments_speaker ON segments(speaker) WHERE speaker IS NOT NULL;
`,
  },
  {
    version: 5,
    name: "cast: chapter where each character first appears",
    sql: /* sql */ `
-- 0-based chapter index where casting first saw the character. The adaptation prompt shows a
-- character's description only from that chapter on, so it cannot leak a later reveal.
ALTER TABLE cast_members ADD COLUMN first_chapter_idx INTEGER CHECK (first_chapter_idx IS NULL OR first_chapter_idx >= 0);
`,
  },
  {
    version: 6,
    name: "sound design: job options and progress, sound library snapshots and takes, script and episode revisions",
    sql: /* sql */ `
-- Options a job was queued with (e.g. {"soundDesign": true}). NULL: a job from before this
-- migration, run exactly as before.
ALTER TABLE jobs ADD COLUMN options_json TEXT CHECK (options_json IS NULL OR json_valid(options_json));
-- Set by a person cancelling the job; a running job stops at its next heartbeat.
ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1));
-- The sound-library snapshot a job is working from, bound when it starts; kept until it ends.
ALTER TABLE jobs ADD COLUMN sfx_snapshot_id TEXT;

-- What each stage of a job has done, for the Studio: preparing the sound library, the script,
-- speech and mixing are reported separately.
CREATE TABLE job_progress (
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL CHECK (stage IN ('library', 'script', 'speech', 'mix')),
  state       TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'skipped', 'failed')),
  done        INTEGER NOT NULL DEFAULT 0 CHECK (done >= 0),
  total       INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  message     TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (job_id, stage)
);

-- One generated sound-effect take. key = sha256 of the model identity, prompt, duration, seed and
-- take number; it is also the Idempotency-Key sent to the server, so a request whose answer was
-- lost is reconciled, not submitted as new work. 'inflight' rows carry the builder's lease.
CREATE TABLE sfx_takes (
  key           TEXT PRIMARY KEY CHECK (length(key) = 64),
  cue_id        TEXT NOT NULL,
  take          INTEGER NOT NULL CHECK (take >= 1),
  prompt        TEXT NOT NULL,
  duration_sec  REAL NOT NULL,
  seed          INTEGER NOT NULL,
  model_json    TEXT NOT NULL CHECK (json_valid(model_json)),
  state         TEXT NOT NULL CHECK (state IN ('inflight', 'done', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until   INTEGER,
  file          TEXT,
  sha256        TEXT,
  error         TEXT,
  updated_at    INTEGER NOT NULL,
  CHECK ((state = 'done') = (file IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX sfx_takes_cue ON sfx_takes(cue_id, take);

-- Published, immutable sound-library snapshots. Jobs mix from the snapshot their script was
-- checked against; at most one is current.
CREATE TABLE sfx_snapshots (
  id           TEXT PRIMARY KEY,
  dir          TEXT NOT NULL,
  prompts_sha  TEXT NOT NULL,
  model_json   TEXT CHECK (model_json IS NULL OR json_valid(model_json)),
  report_json  TEXT NOT NULL CHECK (json_valid(report_json)),
  is_current   INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX sfx_snapshots_current ON sfx_snapshots(is_current) WHERE is_current = 1;

-- One builder of the shared library at a time, across processes.
CREATE TABLE library_locks (
  name         TEXT PRIMARY KEY,
  holder       TEXT NOT NULL,
  lease_until  INTEGER NOT NULL
);

-- Script revisions: 'adaptation' (written from the chapter) or 'sound_design' (a saved script
-- with cues added; its speech is identical to the parent's, checked in code).
ALTER TABLE scripts ADD COLUMN origin TEXT NOT NULL DEFAULT 'adaptation' CHECK (origin IN ('adaptation', 'sound_design'));
ALTER TABLE scripts ADD COLUMN parent_id TEXT REFERENCES scripts(id) ON DELETE SET NULL;
ALTER TABLE scripts ADD COLUMN sfx_snapshot_id TEXT;

-- Every verified mix of an episode. The episode row points at the one on air; earlier ones stay
-- playable until a replacement has passed every check.
CREATE TABLE episode_revisions (
  id            TEXT PRIMARY KEY,
  chapter_id    TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  script_id     TEXT NOT NULL REFERENCES scripts(id),
  snapshot_id   TEXT,
  dir           TEXT NOT NULL,
  report_json   TEXT NOT NULL CHECK (json_valid(report_json)),
  duration_ms   INTEGER NOT NULL CHECK (duration_ms > 0),
  lufs          REAL NOT NULL,
  true_peak     REAL NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (chapter_id, revision)
);
ALTER TABLE episodes ADD COLUMN revision_id TEXT REFERENCES episode_revisions(id) ON DELETE SET NULL;
`,
  },
];

/**
 * Apply pending migrations in order, each in its own transaction. Tracks progress via PRAGMA user_version.
 *
 * The version is read only after BEGIN IMMEDIATE takes the write lock, so processes that open a
 * fresh database at the same moment (web + worker on first boot) serialise: the second one waits,
 * then sees the version the first one committed and skips that migration.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  for (let i = 0; i < migrations.length; i++) {
    if (migrations[i]!.version !== i + 1) {
      throw new Error(`migration versions must be contiguous from 1; got ${migrations[i]!.version} at index ${i}`);
    }
  }
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    let m: Migration | undefined;
    try {
      const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      if (current > migrations.length) {
        throw new Error(`database schema version ${current} is newer than this build (${migrations.length})`);
      }
      m = migrations[current];
      if (!m) {
        db.exec("COMMIT");
        return migrations.length;
      }
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      if (!m) throw err;
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`, { cause: err });
    }
  }
}
