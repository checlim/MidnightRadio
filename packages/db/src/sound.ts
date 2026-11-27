import type { DatabaseSync } from "node:sqlite";

/**
 * Storage for the sound-design workflow (migration 6): per-job stage progress, the shared sound
 * library (generated takes, published snapshots, the builder lock) and episode revisions. Plain
 * functions over the database; the worker supplies time and fencing.
 */

// --- job progress -------------------------------------------------------------------------------

export const PROGRESS_STAGES = ["library", "script", "speech", "mix"] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];
export type ProgressState = "pending" | "running" | "done" | "skipped" | "failed";

export interface StageProgress {
  state: ProgressState;
  done: number;
  total: number;
  message: string | null;
  updatedAt: number;
}

/** Record where a stage of a job is. Unspecified counts keep their previous value. */
export function setProgress(db: DatabaseSync, jobId: string, stage: ProgressStage, p: { state: ProgressState; done?: number; total?: number; message?: string | null }, now: number): void {
  db.prepare(
    `INSERT INTO job_progress (job_id, stage, state, done, total, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, stage) DO UPDATE SET state = excluded.state,
       done = CASE WHEN ? IS NULL THEN job_progress.done ELSE excluded.done END,
       total = CASE WHEN ? IS NULL THEN job_progress.total ELSE excluded.total END,
       message = CASE WHEN ? = 1 THEN excluded.message ELSE job_progress.message END,
       updated_at = excluded.updated_at`,
  ).run(jobId, stage, p.state, p.done ?? 0, p.total ?? 0, p.message ?? null, now, p.done ?? null, p.total ?? null, p.message === undefined ? 0 : 1);
}

export function getProgress(db: DatabaseSync, jobId: string): Partial<Record<ProgressStage, StageProgress>> {
  const rows = db.prepare("SELECT stage, state, done, total, message, updated_at FROM job_progress WHERE job_id = ?").all(jobId) as {
    stage: ProgressStage;
    state: ProgressState;
    done: number;
    total: number;
    message: string | null;
    updated_at: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.stage, { state: r.state, done: Number(r.done), total: Number(r.total), message: r.message, updatedAt: Number(r.updated_at) }]));
}

// --- library builder lock -----------------------------------------------------------------------

/** Take the named lock if it is free or its lease ran out. Returns whether `holder` now holds it. */
export function acquireLibraryLock(db: DatabaseSync, name: string, holder: string, leaseMs: number, now: number): boolean {
  db.prepare(
    `INSERT INTO library_locks (name, holder, lease_until) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, lease_until = excluded.lease_until
     WHERE library_locks.lease_until < ? OR library_locks.holder = excluded.holder`,
  ).run(name, holder, now + leaseMs, now);
  return (db.prepare("SELECT holder FROM library_locks WHERE name = ?").get(name) as { holder: string }).holder === holder;
}

/** Extend the lease. Returns false if `holder` lost the lock (its lease ran out and someone took it). */
export function renewLibraryLock(db: DatabaseSync, name: string, holder: string, leaseMs: number, now: number): boolean {
  return Number(db.prepare("UPDATE library_locks SET lease_until = ? WHERE name = ? AND holder = ?").run(now + leaseMs, name, holder).changes) === 1;
}

export function releaseLibraryLock(db: DatabaseSync, name: string, holder: string): void {
  db.prepare("DELETE FROM library_locks WHERE name = ? AND holder = ?").run(name, holder);
}

export function libraryLockHolder(db: DatabaseSync, name: string, now: number): string | null {
  const row = db.prepare("SELECT holder, lease_until FROM library_locks WHERE name = ?").get(name) as { holder: string; lease_until: number } | undefined;
  return row && Number(row.lease_until) >= now ? row.holder : null;
}

// --- generated takes ----------------------------------------------------------------------------

export interface TakeRecord {
  key: string;
  cueId: string;
  take: number;
  prompt: string;
  durationSec: number;
  seed: number;
  modelJson: string;
  state: "inflight" | "done" | "failed";
  attempts: number;
  leaseUntil: number | null;
  file: string | null;
  sha256: string | null;
  error: string | null;
  updatedAt: number;
}

interface TakeRow {
  key: string;
  cue_id: string;
  take: number;
  prompt: string;
  duration_sec: number;
  seed: number;
  model_json: string;
  state: TakeRecord["state"];
  attempts: number;
  lease_until: number | null;
  file: string | null;
  sha256: string | null;
  error: string | null;
  updated_at: number;
}
const toTake = (r: TakeRow): TakeRecord => ({
  key: r.key,
  cueId: r.cue_id,
  take: Number(r.take),
  prompt: r.prompt,
  durationSec: Number(r.duration_sec),
  seed: Number(r.seed),
  modelJson: r.model_json,
  state: r.state,
  attempts: Number(r.attempts),
  leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
  file: r.file,
  sha256: r.sha256,
  error: r.error,
  updatedAt: Number(r.updated_at),
});

export function getTake(db: DatabaseSync, key: string): TakeRecord | undefined {
  const row = db.prepare("SELECT * FROM sfx_takes WHERE key = ?").get(key) as TakeRow | undefined;
  return row && toTake(row);
}

export function listTakes(db: DatabaseSync, modelJson: string): TakeRecord[] {
  return (db.prepare("SELECT * FROM sfx_takes WHERE model_json = ? ORDER BY cue_id, take").all(modelJson) as unknown as TakeRow[]).map(toTake);
}

/**
 * Mark a take as being requested now, counting the attempt, before the request is sent. Refused
 * (returns undefined) if the take is done, or in flight under a lease that has not run out. A take
 * left in flight by a crashed builder is claimed again: the caller reconciles it (same idempotency
 * key) rather than starting new work.
 */
export function beginTake(db: DatabaseSync, t: Omit<TakeRecord, "state" | "attempts" | "leaseUntil" | "file" | "sha256" | "error" | "updatedAt">, leaseMs: number, now: number): TakeRecord | undefined {
  db.prepare(
    `INSERT INTO sfx_takes (key, cue_id, take, prompt, duration_sec, seed, model_json, state, attempts, lease_until, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'inflight', 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET state = 'inflight', attempts = sfx_takes.attempts + 1, lease_until = excluded.lease_until, error = NULL, updated_at = excluded.updated_at
     WHERE sfx_takes.state = 'failed' OR (sfx_takes.state = 'inflight' AND sfx_takes.lease_until < ?)`,
  ).run(t.key, t.cueId, t.take, t.prompt, t.durationSec, t.seed, t.modelJson, now + leaseMs, now, now);
  const row = getTake(db, t.key)!;
  return row.state === "inflight" && row.leaseUntil === now + leaseMs ? row : undefined;
}

/**
 * Make every in-flight take claimable again. Only the holder of the library lock writes takes, so
 * when it starts, anything still in flight was left by a builder that stopped or crashed; the
 * next `beginTake` claims it and the caller reconciles it with the same key.
 */
export function reclaimOrphanTakes(db: DatabaseSync, now: number): number {
  return Number(db.prepare("UPDATE sfx_takes SET lease_until = ? WHERE state = 'inflight'").run(now - 1).changes);
}

export function finishTake(db: DatabaseSync, key: string, file: string, sha256: string, now: number): void {
  db.prepare("UPDATE sfx_takes SET state = 'done', file = ?, sha256 = ?, lease_until = NULL, error = NULL, updated_at = ? WHERE key = ?").run(file, sha256, now, key);
}

export function failTake(db: DatabaseSync, key: string, error: string, now: number): void {
  db.prepare("UPDATE sfx_takes SET state = 'failed', lease_until = NULL, error = ?, updated_at = ? WHERE key = ?").run(error.slice(0, 500), now, key);
}

// --- library snapshots --------------------------------------------------------------------------

export interface SnapshotRecord {
  id: string;
  dir: string;
  promptsSha: string;
  modelJson: string | null;
  report: unknown;
  isCurrent: boolean;
  createdAt: number;
}

interface SnapshotRow {
  id: string;
  dir: string;
  prompts_sha: string;
  model_json: string | null;
  report_json: string;
  is_current: number;
  created_at: number;
}
const toSnapshot = (r: SnapshotRow): SnapshotRecord => ({
  id: r.id,
  dir: r.dir,
  promptsSha: r.prompts_sha,
  modelJson: r.model_json,
  report: JSON.parse(r.report_json),
  isCurrent: Number(r.is_current) === 1,
  createdAt: Number(r.created_at),
});

/**
 * Record a published snapshot and make it the current one, in one transaction. Publishing an id
 * again (the same library content, built from changed inputs) refreshes its inputs and report.
 */
export function publishSnapshot(db: DatabaseSync, s: Omit<SnapshotRecord, "isCurrent" | "createdAt">, now: number): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO sfx_snapshots (id, dir, prompts_sha, model_json, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET dir = excluded.dir, prompts_sha = excluded.prompts_sha, model_json = excluded.model_json, report_json = excluded.report_json").run(
      s.id,
      s.dir,
      s.promptsSha,
      s.modelJson,
      JSON.stringify(s.report),
      now,
    );
    db.prepare("UPDATE sfx_snapshots SET is_current = 0 WHERE is_current = 1 AND id != ?").run(s.id);
    db.prepare("UPDATE sfx_snapshots SET is_current = 1 WHERE id = ?").run(s.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function currentSnapshot(db: DatabaseSync): SnapshotRecord | undefined {
  const row = db.prepare("SELECT * FROM sfx_snapshots WHERE is_current = 1").get() as SnapshotRow | undefined;
  return row && toSnapshot(row);
}

export function getSnapshot(db: DatabaseSync, id: string): SnapshotRecord | undefined {
  const row = db.prepare("SELECT * FROM sfx_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
  return row && toSnapshot(row);
}

/**
 * Snapshots that must be kept: the current one, any an unfinished job is bound to, and any a
 * script of a chapter with an unfinished job was checked against (that job may still mix from it).
 */
export function snapshotsInUse(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      `SELECT id FROM sfx_snapshots WHERE is_current = 1
       UNION
       SELECT s.sfx_snapshot_id FROM scripts s JOIN jobs j ON j.ref_id = s.chapter_id
       WHERE j.state IN ('queued', 'running', 'over_budget') AND s.sfx_snapshot_id IS NOT NULL
       UNION
       SELECT sfx_snapshot_id FROM jobs WHERE state IN ('queued', 'running', 'over_budget') AND sfx_snapshot_id IS NOT NULL`,
    )
    .all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export function listSnapshots(db: DatabaseSync): SnapshotRecord[] {
  return (db.prepare("SELECT * FROM sfx_snapshots ORDER BY created_at, rowid").all() as unknown as SnapshotRow[]).map(toSnapshot);
}

/**
 * Bind a job to the current snapshot, in one statement, so a builder collecting unused snapshots
 * either sees the binding or has already made another snapshot current. Returns the snapshot id,
 * or null when there is none yet.
 */
export function bindJobSnapshot(db: DatabaseSync, jobId: string): string | null {
  db.prepare("UPDATE jobs SET sfx_snapshot_id = (SELECT id FROM sfx_snapshots WHERE is_current = 1) WHERE id = ?").run(jobId);
  const row = db.prepare("SELECT sfx_snapshot_id AS id FROM jobs WHERE id = ?").get(jobId) as { id: string | null } | undefined;
  return row?.id ?? null;
}

export function deleteSnapshotRecord(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM sfx_snapshots WHERE id = ? AND is_current = 0").run(id);
}

// --- episode revisions --------------------------------------------------------------------------

export interface RevisionRecord {
  id: string;
  chapterId: string;
  revision: number;
  scriptId: string;
  snapshotId: string | null;
  dir: string;
  report: unknown;
  durationMs: number;
  lufs: number;
  truePeak: number;
  createdAt: number;
}

interface RevisionRow {
  id: string;
  chapter_id: string;
  revision: number;
  script_id: string;
  snapshot_id: string | null;
  dir: string;
  report_json: string;
  duration_ms: number;
  lufs: number;
  true_peak: number;
  created_at: number;
}
const toRevision = (r: RevisionRow): RevisionRecord => ({
  id: r.id,
  chapterId: r.chapter_id,
  revision: Number(r.revision),
  scriptId: r.script_id,
  snapshotId: r.snapshot_id,
  dir: r.dir,
  report: JSON.parse(r.report_json),
  durationMs: Number(r.duration_ms),
  lufs: Number(r.lufs),
  truePeak: Number(r.true_peak),
  createdAt: Number(r.created_at),
});

export const nextRevisionNumber = (db: DatabaseSync, chapterId: string): number =>
  Number((db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM episode_revisions WHERE chapter_id = ?").get(chapterId) as { n: number }).n);

/** Record a verified revision and put it on air, in the caller's transaction (fenced publish). */
export function writeRevision(db: DatabaseSync, r: Omit<RevisionRecord, "createdAt">, files: { mp3: string; cleanMp3: string; vtt: string; stationId: string }, now: number): void {
  db.prepare(
    `INSERT INTO episode_revisions (id, chapter_id, revision, script_id, snapshot_id, dir, report_json, duration_ms, lufs, true_peak, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.id, r.chapterId, r.revision, r.scriptId, r.snapshotId, r.dir, JSON.stringify(r.report), r.durationMs, r.lufs, r.truePeak, now);
  db.prepare(
    `INSERT INTO episodes (id, chapter_id, mp3_path, clean_mp3_path, vtt_path, duration_ms, lufs, true_peak, stale, revision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(chapter_id) DO UPDATE SET mp3_path = excluded.mp3_path, clean_mp3_path = excluded.clean_mp3_path, vtt_path = excluded.vtt_path,
       duration_ms = excluded.duration_ms, lufs = excluded.lufs, true_peak = excluded.true_peak, stale = 0, revision_id = excluded.revision_id`,
  ).run(files.stationId, r.chapterId, files.mp3, files.cleanMp3, files.vtt, r.durationMs, r.lufs, r.truePeak, r.id);
}

export function currentRevision(db: DatabaseSync, chapterId: string): RevisionRecord | undefined {
  const row = db.prepare("SELECT r.* FROM episode_revisions r JOIN episodes e ON e.revision_id = r.id WHERE e.chapter_id = ?").get(chapterId) as RevisionRow | undefined;
  return row && toRevision(row);
}

export function listRevisions(db: DatabaseSync, chapterId: string): RevisionRecord[] {
  return (db.prepare("SELECT * FROM episode_revisions WHERE chapter_id = ? ORDER BY revision").all(chapterId) as unknown as RevisionRow[]).map(toRevision);
}
