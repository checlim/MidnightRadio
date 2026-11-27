import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { bindJobSnapshot, currentSnapshot, getProgress, libraryLockHolder, listSnapshots, openDb, setProgress } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIBRARY_LOCK, LibraryError, prepareLibrary, type LibraryDeps } from "./library.js";
import { fakeSfxServer, writeSourceLibrary, type FakeSfxServer } from "./test-support/fake-sfx.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");

const CUES = [
  { id: "match_strike", prompt: "A match strikes and flares.", durationSec: 1, seed: 10, loopable: false },
  { id: "door_knock", prompt: "Three knocks on a heavy door.", durationSec: 1.5, seed: 20, loopable: false },
  { id: "rain_bed", prompt: "Steady rain bed on a roof.", durationSec: 4, seed: 30, loopable: true },
];

let dir: string;
let db: DatabaseSync;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mr-library-"));
  await writeSourceLibrary(join(dir, "assets"), CUES);
  db = openDb(":memory:");
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'Usher', 'h', 'ready', 0)").run();
  db.prepare("INSERT INTO chapters (id, book_id, idx, title, source_text, canonical_text, word_count, status) VALUES ('c1', 'b1', 0, 'I', 's', 's', 1, 'ready')").run();
  for (const [j, kind] of [["j1", "episode"], ["j2", "sound-design"]]) db.prepare("INSERT INTO jobs (id, kind, ref_id, state, attempts, created_at, updated_at) VALUES (?, ?, 'c1', 'queued', 0, 0, 0)").run(j!, kind!);
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const deps = (server: FakeSfxServer | null, over: Partial<LibraryDeps> = {}): LibraryDeps => ({
  db,
  root: join(dir, "data/sfx-library"),
  sourceDir: join(dir, "assets"),
  musicDir: join(dir, "music-candidates"),
  connect: server ? server.connect : null,
  holder: "j1",
  bind: () => bindJobSnapshot(db, over.holder ?? "j1"),
  takesPerCue: 2,
  lockPollMs: 5,
  log: () => undefined,
  progress: (p) => setProgress(db, over.holder ?? "j1", "library", p, Date.now()),
  ...over,
});

describe.skipIf(!hasFfmpeg)("the library stage (fake sound-effect server, real ffmpeg)", () => {
  it("builds an empty library before use, then reuses the warm one without contacting the server", async () => {
    const server = fakeSfxServer();
    const first = await prepareLibrary(deps(server));
    expect(first.reused).toBe(false);
    expect(server.renders).toHaveLength(6);
    expect(first.catalogue.entries.map((e) => e.id).sort()).toEqual(["door_knock", "match_strike", "rain_bed", "theme_test"]);
    expect(first.catalogue.musicCues.theme).toBe("theme_test");
    expect(first.report.foley.omitted).toEqual([]);
    expect(existsSync(join(first.dir, "index.json")) && existsSync(join(first.dir, "ATTRIBUTION.md")) && existsSync(join(first.dir, "library-report.json"))).toBe(true);
    expect(currentSnapshot(db)!.id).toBe(first.snapshotId);
    expect(getProgress(db, "j1").library).toMatchObject({ state: "done", done: 6, total: 6 });
    expect((db.prepare("SELECT sfx_snapshot_id AS s FROM jobs WHERE id = 'j1'").get() as { s: string }).s).toBe(first.snapshotId);
    // provenance: each generated sound records its model, licence, prompt and seed
    const knock = first.catalogue.entries.find((e) => e.id === "door_knock")!;
    expect(knock.source).toMatchObject({ type: "generated", model: "test-sfx", revision: "rev-1", licence: "CC0-1.0", prompt: CUES[1]!.prompt });

    const again = await prepareLibrary(deps({ ...server, connect: () => Promise.reject(new Error("must not connect")) } as FakeSfxServer, { holder: "j2" }));
    expect(again).toMatchObject({ reused: true, snapshotId: first.snapshotId });
    expect(server.requests).toHaveLength(6);
    expect(libraryLockHolder(db, LIBRARY_LOCK, Date.now())).toBeNull();
  });

  it("rebuilds a damaged snapshot rather than mixing from it", async () => {
    const server = fakeSfxServer();
    const first = await prepareLibrary(deps(server));
    await writeFile(join(first.dir, first.catalogue.entries.find((e) => e.id === "match_strike")!.path), "broken");
    const second = await prepareLibrary(deps(server));
    expect(second.reused).toBe(false);
    expect(second.snapshotId).toBe(first.snapshotId); // same content, same id
    expect(server.renders).toHaveLength(6); // every take reused from the take store
  });

  it("collects a take whose answer was lost with the same key, so the server renders it once", async () => {
    const server = fakeSfxServer();
    server.fault = ({ prompt, n }) => (prompt.startsWith("Three knocks") && n === 1 ? "drop-after-render" : null);
    const lib = await prepareLibrary(deps(server));
    expect(server.renders).toHaveLength(6);
    expect(server.replays).toBe(2); // each of its two takes lost its first answer
    expect(new Set(server.renders).size).toBe(6);
    expect(lib.report.takes.failed).toEqual([]);
  });

  it("against a server without idempotency, counts an uncertain request as an attempt and stops at the limit", async () => {
    const server = fakeSfxServer({ idempotency: false });
    server.fault = ({ prompt }) => (prompt.startsWith("A match") ? "drop" : null);
    const lib = await prepareLibrary(deps(server, { maxAttempts: 2 }));
    expect(server.requests.filter((r) => r.prompt.startsWith("A match"))).toHaveLength(4); // 2 takes × 2 attempts
    expect(lib.report.takes.failed.map((f) => f.cue)).toEqual(["match_strike", "match_strike"]);
    expect(lib.report.foley.omitted).toEqual([{ id: "match_strike", reason: "no takes for the current prompt" }]);
    expect(lib.catalogue.entries.some((e) => e.id === "match_strike")).toBe(false);
  });

  it("resumes after a cancelled build: finished takes are kept, the one in flight is collected, nothing is published half-built", async () => {
    const server = fakeSfxServer();
    const ac = new AbortController();
    server.onRender = (prompt) => {
      if (prompt.startsWith("Three knocks")) ac.abort(new Error("cancelled"));
    };
    await expect(prepareLibrary(deps(server, { signal: ac.signal }))).rejects.toThrow();
    expect(currentSnapshot(db)).toBeUndefined();
    expect(libraryLockHolder(db, LIBRARY_LOCK, Date.now())).toBeNull();
    const snapDir = join(dir, "data/sfx-library/snapshots");
    expect(existsSync(snapDir) ? (await readdir(snapDir)).filter((n) => !n.startsWith(".")) : []).toEqual([]);
    const before = server.renders.length;
    delete server.onRender;
    const lib = await prepareLibrary(deps(server));
    expect(lib.reused).toBe(false);
    expect(server.renders.length - before).toBe(6 - before); // only what was not finished
    expect(new Set(server.renders).size).toBe(6);
    expect(db.prepare("SELECT DISTINCT state FROM sfx_takes").all()).toEqual([{ state: "done" }]);
  });

  it("lets one of two concurrent jobs build while the other waits and uses its library", async () => {
    const server = fakeSfxServer();
    const [a, b] = await Promise.all([prepareLibrary(deps(server)), prepareLibrary(deps(server, { holder: "j2" }))]);
    expect(a.snapshotId).toBe(b.snapshotId);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
    expect(server.renders).toHaveLength(6);
    expect(listSnapshots(db)).toHaveLength(1);
  });

  it("keeps the snapshot an unfinished job is bound to when the library changes, and removes it once the job ends", async () => {
    const server = fakeSfxServer();
    const old = await prepareLibrary(deps(server)); // j1 bound to it
    await writeSourceLibrary(join(dir, "assets"), [...CUES, { id: "owl_hoot", prompt: "An owl hoots twice.", durationSec: 1, seed: 40, loopable: false }]);
    db.prepare("UPDATE jobs SET state = 'queued' WHERE id = 'j2'").run();
    const next = await prepareLibrary(deps(server, { holder: "j2" }));
    expect(next.snapshotId).not.toBe(old.snapshotId);
    expect(server.renders).toHaveLength(8); // only the new cue's takes
    expect(existsSync(old.dir)).toBe(true); // j1 may still mix from it
    expect(listSnapshots(db).map((s) => s.id).sort()).toEqual([old.snapshotId, next.snapshotId].sort());
    db.prepare("UPDATE jobs SET state = 'done' WHERE id = 'j1'").run();
    await writeSourceLibrary(join(dir, "assets"), [...CUES, { id: "owl_hoot", prompt: "An owl hoots twice.", durationSec: 1, seed: 41, loopable: false }]);
    const third = await prepareLibrary(deps(server, { holder: "j2" })); // the next build collects what nobody uses
    expect(existsSync(old.dir)).toBe(false);
    expect(existsSync(third.dir)).toBe(true);
    expect(listSnapshots(db).map((s) => s.id)).toEqual([third.snapshotId]); // j2 is now bound to the third
  });

  it("refuses the local service's tone backend, and explains what to set when there is no server and no library", async () => {
    await expect(prepareLibrary(deps(fakeSfxServer({ model: "fake-sfx" })))).rejects.toThrow(/test backend/);
    await expect(prepareLibrary(deps(null))).rejects.toBeInstanceOf(LibraryError);
    await expect(prepareLibrary(deps(null))).rejects.toThrow(/SFX_SERVICE_URL/);
  });
});
