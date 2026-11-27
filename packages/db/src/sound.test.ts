import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { openDb } from "./open.js";
import { listScripts, loadValidScript, saveAdaptation, writeSoundDesignRevision } from "./scripts.js";
import {
  acquireLibraryLock,
  beginTake,
  bindJobSnapshot,
  currentRevision,
  currentSnapshot,
  failTake,
  finishTake,
  getProgress,
  libraryLockHolder,
  listRevisions,
  nextRevisionNumber,
  publishSnapshot,
  reclaimOrphanTakes,
  releaseLibraryLock,
  renewLibraryLock,
  setProgress,
  snapshotsInUse,
  writeRevision,
} from "./sound.js";

let db: DatabaseSync;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'Dracula', 'h', 'ready', 0)").run();
  db.prepare("INSERT INTO chapters (id, book_id, idx, title, source_text, canonical_text, word_count, status) VALUES ('c1', 'b1', 0, 'I', 's', 's', 1, 'ready')").run();
  db.prepare("INSERT INTO jobs (id, kind, ref_id, state, attempts, created_at, updated_at) VALUES ('j1', 'episode', 'c1', 'queued', 0, 0, 0)").run();
});
afterEach(() => db.close());

describe("migration 6", () => {
  it("adds the tables and columns without touching existing rows", () => {
    expect(MIGRATIONS.at(-1)!.version).toBe(6);
    expect(db.prepare("SELECT options_json, cancel_requested FROM jobs WHERE id = 'j1'").get()).toEqual({ options_json: null, cancel_requested: 0 });
    for (const t of ["job_progress", "sfx_takes", "sfx_snapshots", "library_locks", "episode_revisions"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).toEqual({ name: t });
    }
  });
});

describe("job progress", () => {
  it("keeps one row per stage and counts that are not given", () => {
    setProgress(db, "j1", "library", { state: "running", done: 3, total: 108, message: "generating" }, 10);
    setProgress(db, "j1", "library", { state: "running", done: 4 }, 11);
    setProgress(db, "j1", "speech", { state: "pending" }, 12);
    expect(getProgress(db, "j1")).toEqual({
      library: { state: "running", done: 4, total: 108, message: "generating", updatedAt: 11 },
      speech: { state: "pending", done: 0, total: 0, message: null, updatedAt: 12 },
    });
  });
});

describe("the library builder lock", () => {
  it("has one holder at a time; an expired lease can be taken over and the old holder cannot renew", () => {
    expect(acquireLibraryLock(db, "lib", "job-a", 1_000, 0)).toBe(true);
    expect(acquireLibraryLock(db, "lib", "job-b", 1_000, 500)).toBe(false);
    expect(libraryLockHolder(db, "lib", 500)).toBe("job-a");
    expect(renewLibraryLock(db, "lib", "job-a", 1_000, 900)).toBe(true);
    expect(acquireLibraryLock(db, "lib", "job-b", 1_000, 2_000)).toBe(true); // job-a's lease ran out
    expect(renewLibraryLock(db, "lib", "job-a", 1_000, 2_100)).toBe(false);
    releaseLibraryLock(db, "lib", "job-a"); // not the holder: no effect
    expect(libraryLockHolder(db, "lib", 2_100)).toBe("job-b");
    releaseLibraryLock(db, "lib", "job-b");
    expect(libraryLockHolder(db, "lib", 2_100)).toBeNull();
  });
});

describe("generated takes", () => {
  const take = { key: "a".repeat(64), cueId: "door_creak", take: 1, prompt: "A door creaks.", durationSec: 3, seed: 10, modelJson: '{"model":"m"}' };

  it("claims a take once; a live claim is refused, an abandoned one is reconciled with the same key, a done one never again", () => {
    expect(beginTake(db, take, 1_000, 0)).toMatchObject({ state: "inflight", attempts: 1 });
    expect(beginTake(db, take, 1_000, 500)).toBeUndefined(); // in flight elsewhere
    expect(beginTake(db, take, 1_000, 5_000)).toMatchObject({ state: "inflight", attempts: 2 }); // the builder crashed
    finishTake(db, take.key, "door_creak/take-1.wav", "b".repeat(64), 6_000);
    expect(beginTake(db, take, 1_000, 9_000)).toBeUndefined();
  });

  it("lets a new lock holder reclaim takes a stopped builder left in flight", () => {
    beginTake(db, take, 60_000, 0);
    expect(beginTake(db, take, 60_000, 10)).toBeUndefined();
    expect(reclaimOrphanTakes(db, 10)).toBe(1);
    expect(beginTake(db, take, 60_000, 11)).toMatchObject({ state: "inflight", attempts: 2, key: take.key });
  });

  it("counts every attempt, also after a failure", () => {
    beginTake(db, take, 1_000, 0);
    failTake(db, take.key, "the server failed", 10);
    expect(beginTake(db, take, 1_000, 20)).toMatchObject({ attempts: 2 });
  });
});

describe("snapshots and revisions", () => {
  it("has exactly one current snapshot, and keeps the ones unfinished jobs' scripts use", () => {
    publishSnapshot(db, { id: "s1", dir: "/lib/s1", promptsSha: "p", modelJson: null, report: { cues: [] } }, 1);
    publishSnapshot(db, { id: "s2", dir: "/lib/s2", promptsSha: "p", modelJson: null, report: { cues: [] } }, 2);
    expect(currentSnapshot(db)!.id).toBe("s2");
    publishSnapshot(db, { id: "s2", dir: "/lib/s2", promptsSha: "p", modelJson: null, report: { cues: [] } }, 3); // idempotent
    saveAdaptation(db, "c1", { status: "adapted", providerId: "p", sfxSnapshotId: "s1", attempts: [{ attempt: 1, script: { a: 1 }, report: { ok: true }, issues: [], fidelity: 1, status: "valid", requestId: undefined }] });
    expect(snapshotsInUse(db)).toEqual(new Set(["s1", "s2"])); // j1 is queued for c1
    db.prepare("UPDATE jobs SET state = 'done'").run();
    expect(snapshotsInUse(db)).toEqual(new Set(["s2"]));
  });

  it("binds a job to the current snapshot so it is kept while the job is unfinished", () => {
    expect(bindJobSnapshot(db, "j1")).toBeNull();
    publishSnapshot(db, { id: "s1", dir: "/lib/s1", promptsSha: "p", modelJson: null, report: {} }, 1);
    expect(bindJobSnapshot(db, "j1")).toBe("s1");
    publishSnapshot(db, { id: "s2", dir: "/lib/s2", promptsSha: "p", modelJson: null, report: {} }, 2);
    expect(snapshotsInUse(db)).toEqual(new Set(["s1", "s2"]));
    db.prepare("UPDATE jobs SET state = 'failed'").run();
    expect(snapshotsInUse(db)).toEqual(new Set(["s2"]));
  });

  it("stores a sound-design revision after its parent, and puts verified episode revisions on air", () => {
    saveAdaptation(db, "c1", { status: "adapted", providerId: "p", attempts: [{ attempt: 1, script: { a: 1 }, report: { ok: true }, issues: [], fidelity: 1, status: "valid", requestId: undefined }] });
    const parent = loadValidScript(db, "c1")!;
    expect(parent).toMatchObject({ origin: "adaptation", parentId: null, sfxSnapshotId: null });
    const rev = writeSoundDesignRevision(db, "c1", { parentId: parent.id, script: { a: 2 }, validation: { ok: true }, fidelity: 1, sfxSnapshotId: "s1" });
    expect(loadValidScript(db, "c1")).toMatchObject({ id: rev.id, origin: "sound_design", parentId: parent.id, sfxSnapshotId: "s1", version: 2 });
    expect(listScripts(db, "c1").map((s) => s.version)).toEqual([1, 2]);
    expect(() => writeSoundDesignRevision(db, "c1", { parentId: "nope", script: {}, validation: {}, fidelity: null, sfxSnapshotId: "s1" })).toThrow(/not a valid script/);

    expect(nextRevisionNumber(db, "c1")).toBe(1);
    writeRevision(db, { id: "r1", chapterId: "c1", revision: 1, scriptId: parent.id, snapshotId: null, dir: "/b/r1", report: { cues: [] }, durationMs: 1000, lufs: -16, truePeak: -1.5 }, { mp3: "a", cleanMp3: "b", vtt: "c", stationId: "st" }, 5);
    writeRevision(db, { id: "r2", chapterId: "c1", revision: 2, scriptId: rev.id, snapshotId: "s1", dir: "/b/r2", report: { cues: [1] }, durationMs: 1100, lufs: -16, truePeak: -1.4 }, { mp3: "a2", cleanMp3: "b2", vtt: "c2", stationId: "st" }, 6);
    expect(currentRevision(db, "c1")).toMatchObject({ id: "r2", revision: 2, snapshotId: "s1" });
    expect(listRevisions(db, "c1").map((r) => r.revision)).toEqual([1, 2]);
    expect(nextRevisionNumber(db, "c1")).toBe(3);
  });
});
