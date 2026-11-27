import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Stored adaptations (Task 8.2, Req 4.3, 4.4). Plain types, so this package does not depend on
 * the domain or LLM packages; the shapes match `adaptWithRepair`'s outcome.
 *
 * Every attempt is kept as a numbered version of the chapter's Script, with its validation
 * report, so a failed chapter can be reviewed: status `valid` (passed the gate), `invalid` (a
 * Script that failed it) or `rejected` (the reply was not a usable Script; `json` is null). The
 * chapter's status becomes `adapted` or `failed`. A failed chapter is never rendered.
 */

export type ScriptStatus = "valid" | "invalid" | "rejected";
export type ChapterAdaptStatus = "adapted" | "failed";

export interface StoredAttempt {
  attempt: number;
  script: unknown | null;
  /** The validation report, or for a rejected reply the problems with it. */
  report: unknown | null;
  issues: unknown[];
  fidelity: number | null;
  status: ScriptStatus;
  requestId: string | undefined;
}

export interface AdaptationRecord {
  status: ChapterAdaptStatus;
  /** For a failed chapter: a message safe to show users. */
  message?: string;
  providerId: string;
  attempts: StoredAttempt[];
  /** The sound-library snapshot the attempts were checked against (sound design); none for legacy runs. */
  sfxSnapshotId?: string | null;
}

export interface StoredScript {
  id: string;
  version: number;
  status: ScriptStatus;
  script: unknown | null;
  validation: unknown | null;
  fidelity: number | null;
  /** 'adaptation' (from the chapter) or 'sound_design' (cues added to a saved script). */
  origin: "adaptation" | "sound_design";
  parentId: string | null;
  /** The sound-library snapshot the Script's cues were checked against; null for legacy Scripts. */
  sfxSnapshotId: string | null;
}

/** One stored attempt from an outcome attempt record: decides its status. */
export function storedAttempt(a: { attempt: number; script: unknown | null; report: { ok: boolean; fidelity: number | null } | null; issues: unknown[]; requestId: string | undefined }): StoredAttempt {
  const status: ScriptStatus = a.script === null ? "rejected" : a.report?.ok ? "valid" : "invalid";
  return { attempt: a.attempt, script: a.script, report: a.report, issues: a.issues, fidelity: a.report?.fidelity ?? null, status, requestId: a.requestId };
}

/**
 * Write every attempt as a new version after any existing ones, and set the chapter's status.
 * Does not open a transaction: call it inside `JobQueue.publish` (fenced by the job lease), or
 * use `saveAdaptation`. Refuses a "adapted" record whose last attempt is not valid.
 */
export function writeAdaptation(db: DatabaseSync, chapterId: string, record: AdaptationRecord, newId: () => string = randomUUID): StoredScript[] {
  const chapter = db.prepare("SELECT id FROM chapters WHERE id = ?").get(chapterId);
  if (!chapter) throw new Error(`unknown chapter ${chapterId}`);
  const last = record.attempts[record.attempts.length - 1];
  if (record.status === "adapted" && last?.status !== "valid") throw new Error("an adapted chapter needs a valid last attempt");
  if (record.status === "failed" && record.attempts.some((a) => a.status === "valid")) throw new Error("a failed chapter cannot have a valid attempt");

  const { v } = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM scripts WHERE chapter_id = ?").get(chapterId) as { v: number };
  const insert = db.prepare("INSERT INTO scripts (id, chapter_id, version, json, validation_json, fidelity, status, sfx_snapshot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const snapshot = record.sfxSnapshotId ?? null;
  const written: StoredScript[] = [];
  record.attempts.forEach((a, i) => {
    const id = newId();
    const version = Number(v) + i + 1;
    const validation = { attempt: a.attempt, providerId: record.providerId, requestId: a.requestId ?? null, report: a.report, issues: a.issues };
    insert.run(id, chapterId, version, JSON.stringify(a.script), JSON.stringify(validation), a.fidelity, a.status, snapshot);
    written.push({ id, version, status: a.status, script: a.script, validation, fidelity: a.fidelity, origin: "adaptation", parentId: null, sfxSnapshotId: snapshot });
  });
  db.prepare("UPDATE chapters SET status = ? WHERE id = ?").run(record.status, chapterId);
  return written;
}

/** `writeAdaptation` in its own transaction. */
export function saveAdaptation(db: DatabaseSync, chapterId: string, record: AdaptationRecord, newId?: () => string): StoredScript[] {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = writeAdaptation(db, chapterId, record, newId);
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Store a sound-design revision of a valid Script: the same speech with cues added, checked
 * against `sfxSnapshotId`. It becomes the chapter's newest valid Script; the parent is kept.
 * Does not open a transaction (call it inside a fenced publish).
 */
export function writeSoundDesignRevision(
  db: DatabaseSync,
  chapterId: string,
  r: { parentId: string; script: unknown; validation: unknown; fidelity: number | null; sfxSnapshotId: string },
  newId: () => string = randomUUID,
): StoredScript {
  const parent = db.prepare("SELECT id FROM scripts WHERE id = ? AND chapter_id = ? AND status = 'valid'").get(r.parentId, chapterId);
  if (!parent) throw new Error(`script ${r.parentId} is not a valid script of chapter ${chapterId}`);
  const { v } = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM scripts WHERE chapter_id = ?").get(chapterId) as { v: number };
  const id = newId();
  const version = Number(v) + 1;
  db.prepare("INSERT INTO scripts (id, chapter_id, version, json, validation_json, fidelity, status, origin, parent_id, sfx_snapshot_id) VALUES (?, ?, ?, ?, ?, ?, 'valid', 'sound_design', ?, ?)").run(
    id,
    chapterId,
    version,
    JSON.stringify(r.script),
    JSON.stringify(r.validation),
    r.fidelity,
    r.parentId,
    r.sfxSnapshotId,
  );
  return { id, version, status: "valid", script: r.script, validation: r.validation, fidelity: r.fidelity, origin: "sound_design", parentId: r.parentId, sfxSnapshotId: r.sfxSnapshotId };
}

/** The chapter's newest valid Script: the one rendering uses. Undefined if it has none. */
export function loadValidScript(db: DatabaseSync, chapterId: string): StoredScript | undefined {
  const row = db
    .prepare("SELECT id, version, status, json, validation_json AS validation, fidelity, origin, parent_id, sfx_snapshot_id FROM scripts WHERE chapter_id = ? AND status = 'valid' ORDER BY version DESC LIMIT 1")
    .get(chapterId) as ScriptRow | undefined;
  return row && toStored(row);
}

/** Every stored version of the chapter's Script, oldest first, for review. */
export function listScripts(db: DatabaseSync, chapterId: string): StoredScript[] {
  const rows = db.prepare("SELECT id, version, status, json, validation_json AS validation, fidelity, origin, parent_id, sfx_snapshot_id FROM scripts WHERE chapter_id = ? ORDER BY version").all(chapterId) as unknown as ScriptRow[];
  return rows.map(toStored);
}

/** A stored Script by id. */
export function loadScript(db: DatabaseSync, scriptId: string): StoredScript | undefined {
  const row = db.prepare("SELECT id, version, status, json, validation_json AS validation, fidelity, origin, parent_id, sfx_snapshot_id FROM scripts WHERE id = ?").get(scriptId) as ScriptRow | undefined;
  return row && toStored(row);
}

interface ScriptRow {
  id: string;
  version: number;
  status: ScriptStatus;
  json: string;
  validation: string | null;
  fidelity: number | null;
  origin: "adaptation" | "sound_design";
  parent_id: string | null;
  sfx_snapshot_id: string | null;
}
const toStored = (r: ScriptRow): StoredScript => ({
  id: r.id,
  version: Number(r.version),
  status: r.status,
  script: JSON.parse(r.json),
  validation: r.validation === null ? null : JSON.parse(r.validation),
  fidelity: r.fidelity,
  origin: r.origin,
  parentId: r.parent_id,
  sfxSnapshotId: r.sfx_snapshot_id,
});
