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
}

export interface StoredScript {
  id: string;
  version: number;
  status: ScriptStatus;
  script: unknown | null;
  validation: unknown | null;
  fidelity: number | null;
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
  const insert = db.prepare("INSERT INTO scripts (id, chapter_id, version, json, validation_json, fidelity, status) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const written: StoredScript[] = [];
  record.attempts.forEach((a, i) => {
    const id = newId();
    const version = Number(v) + i + 1;
    const validation = { attempt: a.attempt, providerId: record.providerId, requestId: a.requestId ?? null, report: a.report, issues: a.issues };
    insert.run(id, chapterId, version, JSON.stringify(a.script), JSON.stringify(validation), a.fidelity, a.status);
    written.push({ id, version, status: a.status, script: a.script, validation, fidelity: a.fidelity });
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

/** The chapter's newest valid Script: the one rendering uses. Undefined if it has none. */
export function loadValidScript(db: DatabaseSync, chapterId: string): StoredScript | undefined {
  const row = db
    .prepare("SELECT id, version, status, json, validation_json AS validation, fidelity FROM scripts WHERE chapter_id = ? AND status = 'valid' ORDER BY version DESC LIMIT 1")
    .get(chapterId) as { id: string; version: number; status: ScriptStatus; json: string; validation: string | null; fidelity: number | null } | undefined;
  if (!row) return undefined;
  return { id: row.id, version: Number(row.version), status: row.status, script: JSON.parse(row.json), validation: row.validation === null ? null : JSON.parse(row.validation), fidelity: row.fidelity };
}

/** Every stored version of the chapter's Script, oldest first, for review. */
export function listScripts(db: DatabaseSync, chapterId: string): StoredScript[] {
  const rows = db.prepare("SELECT id, version, status, json, validation_json AS validation, fidelity FROM scripts WHERE chapter_id = ? ORDER BY version").all(chapterId) as { id: string; version: number; status: ScriptStatus; json: string; validation: string | null; fidelity: number | null }[];
  return rows.map((r) => ({ id: r.id, version: Number(r.version), status: r.status, script: JSON.parse(r.json), validation: r.validation === null ? null : JSON.parse(r.validation), fidelity: r.fidelity }));
}
