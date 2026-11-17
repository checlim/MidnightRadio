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
];

/** Apply pending migrations in order, each in its own transaction. Tracks progress via PRAGMA user_version. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  for (let i = 0; i < migrations.length; i++) {
    if (migrations[i]!.version !== i + 1) {
      throw new Error(`migration versions must be contiguous from 1; got ${migrations[i]!.version} at index ${i}`);
    }
  }
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (current > migrations.length) {
    throw new Error(`database schema version ${current} is newer than this build (${migrations.length})`);
  }
  for (const m of migrations.slice(current)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return migrations.length;
}
