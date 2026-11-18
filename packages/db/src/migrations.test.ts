import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";
import { openDb } from "./open.js";
import { runConcurrently } from "./test-support/processes.js";

const NOW = 1_700_000_000_000;
let db: DatabaseSync;

const insertBook = (id = "b1") =>
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES (?, 'T', 'h', 'ready', ?)").run(id, NOW);
const insertChapter = (id = "c1", bookId = "b1", idx = 0, part = 1) =>
  db
    .prepare(
      `INSERT INTO chapters (id, book_id, idx, title, part, part_count, source_text, canonical_text, word_count, status)
       VALUES (?, ?, ?, 'Ch', ?, 2, 's', 'c', 1, 'ready')`,
    )
    .run(id, bookId, idx, part);
const insertScript = (id = "s1", chapterId = "c1", version = 1) =>
  db.prepare("INSERT INTO scripts (id, chapter_id, version, json, status) VALUES (?, ?, ?, '{}', 'valid')").run(id, chapterId, version);
const insertJob = (id: string, state: string, kind = "render", ref = "c1", lease: [string, number] | null = null) =>
  db
    .prepare(
      "INSERT INTO jobs (id, kind, ref_id, state, lease_token, lease_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, kind, ref, state, lease?.[0] ?? null, lease?.[1] ?? null, NOW, NOW);

beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.close());

describe("migrate", () => {
  it("creates every table and sets user_version", () => {
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toEqual(
      ["books", "budget_reservations", "cast_members", "chapters", "episodes", "jobs", "scripts", "segments", "usage"].sort(),
    );
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  });

  it("is idempotent", () => {
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  });

  it("refuses a database newer than the build", () => {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this build/);
  });

  it("rolls back a failing migration and leaves the version unchanged", () => {
    const bad = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: "bad", sql: "CREATE TABLE x (a); SELECT nope FROM missing;" }];
    expect(() => migrate(db, bad)).toThrow(new RegExp(`migration ${MIGRATIONS.length + 1} \\(bad\\) failed`));
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'x'").get()).toBeUndefined();
  });

  it("lets several processes open and migrate a fresh database file at the same time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-boot-"));
    try {
      const child = join(dirname(fileURLToPath(import.meta.url)), "test-support/open-child.ts");
      for (let trial = 0; trial < 5; trial++) {
        const path = join(dir, `boot-${trial}.db`);
        const out = await runConcurrently(child, Array.from({ length: 4 }, () => [path]));
        expect(out).toEqual(["ok", "ok", "ok", "ok"]);
        const d = openDb(path);
        expect(d.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("persists across reopen of a file database", () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-db-"));
    try {
      const path = join(dir, "test.db");
      const a = openDb(path);
      a.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b', 'T', 'h', 'ready', ?)").run(NOW);
      a.close();
      const b = openDb(path);
      expect(b.prepare("SELECT id FROM books").all()).toEqual([{ id: "b" }]);
      expect(b.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("constraints", () => {
  beforeEach(() => {
    insertBook();
    insertChapter();
  });

  it("enforces foreign keys and cascades book deletion", () => {
    expect(() => insertChapter("c9", "missing")).toThrow(/FOREIGN KEY/);
    insertScript();
    db.prepare("DELETE FROM books WHERE id = 'b1'").run();
    expect(db.prepare("SELECT COUNT(*) n FROM scripts").get()).toEqual({ n: 0 });
  });

  it("keeps spend history when a book is deleted", () => {
    db.prepare(
      "INSERT INTO budget_reservations (id, day_utc, book_id, chapter_id, tts_chars, state, created_at, updated_at) VALUES ('r', '2026-11-15', 'b1', 'c1', 100, 'uncertain', ?, ?)",
    ).run(NOW, NOW);
    db.prepare("INSERT INTO usage (id, day_utc, book_id, chapter_id, tts_chars) VALUES ('u', '2026-11-15', 'b1', 'c1', 100)").run();
    db.prepare("DELETE FROM books WHERE id = 'b1'").run();
    expect(db.prepare("SELECT book_id, tts_chars FROM budget_reservations").get()).toEqual({ book_id: null, tts_chars: 100 });
    expect(db.prepare("SELECT book_id, tts_chars FROM usage").get()).toEqual({ book_id: null, tts_chars: 100 });
  });

  it("keeps split-chapter parts unique and valid", () => {
    insertChapter("c2", "b1", 0, 2);
    expect(() => insertChapter("c3", "b1", 0, 2)).toThrow(/UNIQUE/);
    expect(() => insertChapter("c4", "b1", 1, 3)).toThrow(/CHECK/); // part 3 of 2
  });

  it("validates the quote inventory columns", () => {
    expect(() => db.prepare("UPDATE chapters SET quote_spans_json = 'not json' WHERE id = 'c1'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE chapters SET quote_parse_status = 'guessed' WHERE id = 'c1'").run()).toThrow(/CHECK/);
    db.prepare(
      "UPDATE chapters SET quote_spans_json = '[{\"id\":\"q1\",\"start\":0,\"end\":5}]', quote_parse_status = 'ok', quote_parser_version = 'qp-1', normaliser_version = 'n-1' WHERE id = 'c1'",
    ).run();
  });

  it("bounds fidelity to [0, 1] and versions per chapter", () => {
    insertScript();
    expect(() => insertScript("s2", "c1", 1)).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE scripts SET fidelity = 1.01").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE scripts SET fidelity = -0.1").run()).toThrow(/CHECK/);
  });

  it("enforces segment section/scene consistency and unique ordering", () => {
    insertScript();
    const seg = db.prepare("INSERT INTO segments (id, script_id, section, scene_idx, idx, kind, status) VALUES (?, 's1', ?, ?, ?, 'pause', 'pending')");
    seg.run("g1", "coldOpen", null, 0);
    seg.run("g2", "scenes", 0, 0);
    expect(() => seg.run("g3", "coldOpen", null, 0)).toThrow(/UNIQUE/);
    expect(() => seg.run("g4", "scenes", null, 1)).toThrow(/CHECK/);
    expect(() => seg.run("g5", "close", 0, 0)).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO segments (id, script_id, section, idx, kind, status) VALUES ('g6', 's1', 'close', 0, 'song', 'x')").run(),
    ).toThrow(/CHECK/);
  });

  it("assigns distinct voices within a book", () => {
    const cm = db.prepare("INSERT INTO cast_members (id, book_id, name, role, voice_id) VALUES (?, 'b1', ?, 'character', ?)");
    cm.run("m1", "Harker", "v1");
    cm.run("m2", "Mina", null);
    cm.run("m3", "Lucy", null);
    expect(() => cm.run("m4", "Dracula", "v1")).toThrow(/UNIQUE/);
  });

  it("allows one active job per (kind, ref_id) and requires a lease while running", () => {
    insertJob("j1", "queued");
    expect(() => insertJob("j2", "queued")).toThrow(/UNIQUE/);
    expect(() => insertJob("j3", "running", "render", "c1", ["t", NOW])).toThrow(/UNIQUE/);
    insertJob("j4", "done");
    insertJob("j5", "queued", "adapt");
    expect(() => insertJob("j6", "running", "cast", "b1")).toThrow(/CHECK/);
    expect(() => insertJob("j7", "queued", "cast", "b1", ["t", NOW])).toThrow(/CHECK/);
    insertJob("j8", "running", "cast", "b1", ["t", NOW + 30_000]);
  });

  it("requires actual usage before a reservation is settled", () => {
    const r = db.prepare(
      "INSERT INTO budget_reservations (id, day_utc, llm_tokens, state, actual_llm_tokens, actual_tts_chars, created_at, updated_at) VALUES (?, ?, 500, ?, ?, ?, ?, ?)",
    );
    expect(() => r.run("r1", "2026-11-15", "settled", null, null, NOW, NOW)).toThrow(/CHECK/);
    expect(() => r.run("r2", "15/11/2026", "reserved", null, null, NOW, NOW)).toThrow(/CHECK/);
    expect(() => r.run("r3", "2026-11-15", "refunded", null, null, NOW, NOW)).toThrow(/CHECK/);
    r.run("r4", "2026-11-15", "settled", 420, 0, NOW, NOW);
  });
});
