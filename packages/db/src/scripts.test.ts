import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./open.js";
import { listScripts, loadValidScript, saveAdaptation, storedAttempt, writeAdaptation, type AdaptationRecord } from "./scripts.js";

let db: DatabaseSync;
let n = 0;
const newId = () => `s${++n}`;
beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'Dracula', 'h', 'ready', 0)").run();
  db.prepare("INSERT INTO chapters (id, book_id, idx, title, source_text, canonical_text, word_count, status) VALUES ('c1', 'b1', 0, 'I', 's', 's', 1, 'ingested')").run();
});
afterEach(() => db.close());

const script = { bookId: "b1", chapterId: "c1", episodeNumber: 1, coldOpen: [], scenes: [], close: [] };
const report = (ok: boolean, fidelity: number | null) => ({ ok, fidelity, validatorVersion: "validate-1" });
const status = () => (db.prepare("SELECT status FROM chapters WHERE id = 'c1'").get() as { status: string }).status;

describe("storedAttempt", () => {
  it("is rejected without a Script, valid when the report passed, invalid otherwise", () => {
    expect(storedAttempt({ attempt: 1, script: null, report: null, issues: [{ path: "close" }], requestId: "r1" })).toMatchObject({ status: "rejected", fidelity: null });
    expect(storedAttempt({ attempt: 2, script, report: report(false, 0.5), issues: [], requestId: undefined })).toMatchObject({ status: "invalid", fidelity: 0.5 });
    expect(storedAttempt({ attempt: 3, script, report: report(true, 1), issues: [], requestId: undefined })).toMatchObject({ status: "valid", fidelity: 1 });
  });
});

describe("saveAdaptation", () => {
  const adapted: AdaptationRecord = {
    status: "adapted",
    providerId: "stub",
    attempts: [
      storedAttempt({ attempt: 1, script: null, report: null, issues: [{ path: "close", message: "x" }], requestId: "r1" }),
      storedAttempt({ attempt: 2, script, report: report(false, 0.5), issues: [{ path: "(missing q1)", message: "y" }], requestId: "r2" }),
      storedAttempt({ attempt: 3, script, report: report(true, 1), issues: [], requestId: "r3" }),
    ],
  };

  it("keeps every attempt as a version with its report, and marks the chapter adapted", () => {
    const written = saveAdaptation(db, "c1", adapted, newId);
    expect(written.map((w) => [w.version, w.status, w.fidelity])).toEqual([[1, "rejected", null], [2, "invalid", 0.5], [3, "valid", 1]]);
    expect(status()).toBe("adapted");
    expect(listScripts(db, "c1")[0]).toMatchObject({ script: null, validation: { attempt: 1, providerId: "stub", requestId: "r1", report: null, issues: [{ path: "close" }] } });
    expect(loadValidScript(db, "c1")).toMatchObject({ version: 3, status: "valid", script, fidelity: 1, validation: { report: { ok: true } } });
  });

  it("numbers a later adaptation after the earlier versions, and serves the newest valid one", () => {
    saveAdaptation(db, "c1", adapted, newId);
    saveAdaptation(db, "c1", { ...adapted, attempts: [adapted.attempts[2]!] }, newId);
    expect(listScripts(db, "c1").map((s) => s.version)).toEqual([1, 2, 3, 4]);
    expect(loadValidScript(db, "c1")!.version).toBe(4);
  });

  it("marks a failed chapter failed and gives it no Script to render", () => {
    const failed: AdaptationRecord = { status: "failed", message: "No adaptation passed validation.", providerId: "stub", attempts: adapted.attempts.slice(0, 2) };
    saveAdaptation(db, "c1", failed, newId);
    expect(status()).toBe("failed");
    expect(loadValidScript(db, "c1")).toBeUndefined();
    expect(listScripts(db, "c1")).toHaveLength(2);
    // a failure with no attempts at all (unreadable quotations) is recorded too
    db.prepare("INSERT INTO chapters (id, book_id, idx, title, source_text, canonical_text, word_count, status) VALUES ('c2', 'b1', 1, 'II', 's', 's', 1, 'ingested')").run();
    saveAdaptation(db, "c2", { status: "failed", providerId: "stub", attempts: [] }, newId);
    expect((db.prepare("SELECT status FROM chapters WHERE id = 'c2'").get() as { status: string }).status).toBe("failed");
  });

  it("refuses contradictory records and rolls back", () => {
    expect(() => saveAdaptation(db, "c1", { ...adapted, attempts: adapted.attempts.slice(0, 2) }, newId)).toThrow(/needs a valid last attempt/);
    expect(() => saveAdaptation(db, "c1", { status: "failed", providerId: "stub", attempts: adapted.attempts }, newId)).toThrow(/cannot have a valid attempt/);
    expect(() => saveAdaptation(db, "nope", adapted, newId)).toThrow(/unknown chapter/);
    expect(listScripts(db, "c1")).toEqual([]);
    expect(status()).toBe("ingested");
  });

  it("joins the caller's transaction, so a failure later in it undoes everything", () => {
    db.exec("BEGIN IMMEDIATE");
    writeAdaptation(db, "c1", adapted, newId);
    db.exec("ROLLBACK");
    expect(listScripts(db, "c1")).toEqual([]);
    expect(status()).toBe("ingested");
  });
});
