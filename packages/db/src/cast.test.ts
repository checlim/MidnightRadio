import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CastConflictError, CastFrozenError, CastPinMismatchError, addCastMembers, editCastVoices, loadCast, saveCast, writeCast, type CastMember } from "./cast.js";
import { openDb } from "./open.js";

const PIN = { catalogueId: "stub-voices-1", catalogueHash: "a".repeat(64) };
const member = (name: string, extra: Partial<CastMember> = {}): CastMember => ({
  name,
  role: "character",
  aliases: [],
  genderPresentation: "unstated",
  ageBand: "unknown",
  description: `${name} appears.`,
  voiceId: null,
  voiceFit: null,
  mentionCount: 0,
  speaks: false,
  ...extra,
});
const reserved = (): CastMember[] => [
  member("Announcer", { role: "announcer", voiceId: "stub-announcer" }),
  member("Narrator", { role: "narrator", voiceId: "stub-narrator" }),
];
const full = (): CastMember[] => [
  ...reserved(),
  member("Count Dracula", { aliases: ["Dracula", "the Count"], genderPresentation: "masculine", ageBand: "older", voiceId: "stub-m2", voiceFit: "good", mentionCount: 210, speaks: true, firstChapterIdx: 1 }),
  member("Mina Harker", { genderPresentation: "feminine", voiceId: "stub-f1", voiceFit: "good", mentionCount: 306, speaks: true }),
  member("The landlady", { genderPresentation: "feminine", mentionCount: 2 }),
];

let db: DatabaseSync;
let n: number;
const newId = () => `m${++n}`;
beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'Dracula', 'h', 'ready', 0)").run();
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b2', 'Usher', 'h', 'ready', 0)").run();
});
afterEach(() => db.close());

describe("saveCast / loadCast", () => {
  it("has no Cast until one is saved", () => {
    expect(loadCast(db, "b1")).toBeUndefined();
    expect(loadCast(db, "missing")).toBeUndefined();
  });

  it("stores the Cast with the pinned catalogue and reads it back", () => {
    saveCast(db, "b1", PIN, full(), newId);
    const cast = loadCast(db, "b1")!;
    expect(cast.pin).toEqual(PIN);
    expect(cast.announcer).toMatchObject({ name: "Announcer", voiceId: "stub-announcer" });
    expect(cast.narrator).toMatchObject({ name: "Narrator", voiceId: "stub-narrator" });
    expect(cast.characters.map((c) => c.name)).toEqual(["Mina Harker", "Count Dracula", "The landlady"]);
    expect(cast.characters[1]).toEqual(full()[2]); // lossless round trip, aliases included
    expect(cast.characters[2]).toMatchObject({ voiceId: null, voiceFit: null, speaks: false });
    expect(cast.announcer).not.toHaveProperty("firstChapterIdx"); // none stored, none read back
  });

  it("freezes the Cast: a second save is refused and changes nothing (Req 2.3)", () => {
    saveCast(db, "b1", PIN, full(), newId);
    const other = [...reserved(), member("Renfield", { voiceId: "stub-m1", speaks: true })];
    expect(() => saveCast(db, "b1", { ...PIN, catalogueHash: "b".repeat(64) }, other, newId)).toThrow(CastFrozenError);
    const cast = loadCast(db, "b1")!;
    expect(cast.pin).toEqual(PIN);
    expect(cast.characters).toHaveLength(3);
  });

  it("keeps Casts of different books separate, so voices can repeat across books but not within one", () => {
    saveCast(db, "b1", PIN, full(), newId);
    expect(() => saveCast(db, "b2", PIN, full(), newId)).not.toThrow();
    expect(loadCast(db, "b2")!.characters).toHaveLength(3);
  });

  it("rolls everything back if any member is rejected", () => {
    const clash = [...full(), member("Lucy", { voiceId: "stub-f1", speaks: true })]; // stub-f1 is Mina's
    expect(() => saveCast(db, "b1", PIN, clash, newId)).toThrow(/UNIQUE/);
    expect(loadCast(db, "b1")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) n FROM cast_members").get()).toEqual({ n: 0 });
    expect(() => saveCast(db, "b1", PIN, full(), newId)).not.toThrow(); // and the Book is still castable
  });

  it("makes the reserved voices unavailable to characters, even if code forgets to check", () => {
    const stolen = [...reserved(), member("Dracula", { voiceId: "stub-announcer", speaks: true })];
    expect(() => saveCast(db, "b1", PIN, stolen, newId)).toThrow(/UNIQUE/);
    const stolenNarrator = [...reserved(), member("Mina", { voiceId: "stub-narrator", speaks: true })];
    expect(() => saveCast(db, "b1", PIN, stolenNarrator, newId)).toThrow(/UNIQUE/);
  });

  it.each([
    ["no Announcer", () => full().filter((m) => m.role !== "announcer"), /exactly one announcer/],
    ["two Narrators", () => [...full(), member("Narrator 2", { role: "narrator", voiceId: "x" })], /exactly one narrator/],
    ["a reserved role without a voice", () => full().map((m) => (m.role === "narrator" ? { ...m, voiceId: null } : m)), /narrator needs a voice/],
    ["a speaker without a voice", () => [...reserved(), member("Mute", { speaks: true })], /has no voice/],
    ["a silent character with a voice", () => [...reserved(), member("Quiet", { voiceId: "stub-f2" })], /must not hold a voice/],
    ["an unknown role", () => [...reserved(), { ...member("Odd"), role: "extra" as never }], /unknown cast role/],
    ["a blank name", () => [...reserved(), member("  ")], /need a name/],
  ])("refuses %s", (_label, build, message) => {
    expect(() => saveCast(db, "b1", PIN, build(), newId)).toThrow(message);
    expect(loadCast(db, "b1")).toBeUndefined();
  });

  it("refuses an unknown book and duplicate names within a book", () => {
    expect(() => saveCast(db, "nope", PIN, full(), newId)).toThrow(/unknown book/);
    expect(() => saveCast(db, "b1", PIN, [...full(), member("Mina Harker")], newId)).toThrow(/UNIQUE/);
  });

  it("deleting a Book removes its Cast", () => {
    saveCast(db, "b1", PIN, full(), newId);
    db.prepare("DELETE FROM books WHERE id = 'b1'").run();
    expect(db.prepare("SELECT COUNT(*) n FROM cast_members").get()).toEqual({ n: 0 });
  });
});

describe("writeCast inside another transaction", () => {
  it("joins the caller's transaction, so a failure later in it undoes the Cast", () => {
    db.exec("BEGIN IMMEDIATE");
    writeCast(db, "b1", PIN, full(), newId);
    expect(loadCast(db, "b1")).toBeDefined();
    db.exec("ROLLBACK");
    expect(loadCast(db, "b1")).toBeUndefined();
  });
});

describe("addCastMembers (Req 2.4)", () => {
  beforeEach(() => {
    saveCast(db, "b1", PIN, full(), newId);
    db.prepare("INSERT INTO chapters (id, book_id, idx, title, source_text, canonical_text, word_count, status) VALUES ('c2', 'b1', 2, 'II', 's', 's', 1, 'ready')").run();
    db.prepare("INSERT INTO chapters (id, book_id, idx, title, source_text, canonical_text, word_count, status) VALUES ('u1', 'b2', 1, 'I', 's', 's', 1, 'ready')").run();
  });

  const renfield = () => member("Renfield", { genderPresentation: "masculine", ageBand: "adult", voiceId: "stub-m1", voiceFit: "fair", mentionCount: 48, speaks: true });

  it("adds the character, records the chapter that introduced them, and leaves everyone else untouched", () => {
    const before = loadCast(db, "b1")!;
    addCastMembers(db, "b1", PIN, [renfield(), member("Mr. Swales")], "c2", newId);
    const after = loadCast(db, "b1")!;
    expect(after.pin).toEqual(before.pin);
    expect(after.characters.filter((c) => c.name !== "Renfield" && c.name !== "Mr. Swales")).toEqual(before.characters);
    expect(after.characters.find((c) => c.name === "Renfield")).toEqual(renfield());
    expect(db.prepare("SELECT name, added_in_chapter AS ch FROM cast_members WHERE added_in_chapter IS NOT NULL ORDER BY name").all()).toEqual([
      { name: "Mr. Swales", ch: "c2" },
      { name: "Renfield", ch: "c2" },
    ]);
  });

  it("refuses a voice or name already in the Cast, the reserved voices included, and adds nothing", () => {
    const attempts = [
      [renfield(), member("Lucy", { voiceId: "stub-f1", speaks: true })], // Mina's voice
      [member("Lucy", { voiceId: "stub-announcer", speaks: true })],
      [member("Mina Harker")],
    ];
    for (const additions of attempts) {
      expect(() => addCastMembers(db, "b1", PIN, additions, "c2", newId)).toThrow(CastConflictError);
    }
    expect(loadCast(db, "b1")!.characters).toHaveLength(3);
  });

  it("refuses a Book without a Cast, another catalogue pin, a non-character, an invalid member, and a chapter of another book", () => {
    expect(() => addCastMembers(db, "b2", PIN, [renfield()], null, newId)).toThrow(CastPinMismatchError);
    expect(() => addCastMembers(db, "b1", { ...PIN, catalogueHash: "b".repeat(64) }, [renfield()], null, newId)).toThrow(CastPinMismatchError);
    expect(() => addCastMembers(db, "b1", PIN, [member("Narrator 2", { role: "narrator", voiceId: "stub-f4" })], null, newId)).toThrow(/only characters/);
    expect(() => addCastMembers(db, "b1", PIN, [member("Mute", { speaks: true })], null, newId)).toThrow(/has no voice/);
    expect(() => addCastMembers(db, "b1", PIN, [renfield()], "u1", newId)).toThrow(/not part of book b1/);
    expect(loadCast(db, "b1")!.characters).toHaveLength(3);
  });
});

describe("editCastVoices (Req 2.5)", () => {
  /** Two chapters of b1 with an episode each, plus a b2 chapter whose speaker shares a name. */
  beforeEach(() => {
    saveCast(db, "b1", PIN, full(), newId);
    saveCast(db, "b2", PIN, full(), newId);
    const chapter = db.prepare("INSERT INTO chapters (id, book_id, idx, title, source_text, canonical_text, word_count, status) VALUES (?, ?, ?, 't', 's', 's', 1, 'ready')");
    const script = db.prepare("INSERT INTO scripts (id, chapter_id, version, json, status) VALUES (?, ?, 1, '{}', 'valid')");
    const episode = db.prepare("INSERT INTO episodes (id, chapter_id, mp3_path, clean_mp3_path, vtt_path, duration_ms) VALUES (?, ?, 'a.mp3', 'c.mp3', 'a.vtt', 1000)");
    const segment = db.prepare(
      `INSERT INTO segments (id, script_id, section, scene_idx, idx, kind, speaker, text, cache_key, audio_path, duration_ms, status)
       VALUES (?, ?, 'scenes', 0, ?, ?, ?, 'line', ?, ?, 900, 'rendered')`,
    );
    for (const [ch, book, idx] of [["c1", "b1", 1], ["c2", "b1", 2], ["c3", "b1", 3], ["u1", "b2", 1]] as const) {
      chapter.run(ch, book, idx);
      script.run(`s-${ch}`, ch);
      episode.run(`e-${ch}`, ch);
    }
    const lines: [string, string, number, string, string | null][] = [
      ["c1", "g1", 0, "narration", null],
      ["c1", "g2", 1, "dialogue", "Mina Harker"],
      ["c1", "g3", 2, "dialogue", "Count Dracula"],
      ["c2", "g4", 0, "dialogue", "Count Dracula"],
      ["c3", "g5", 0, "dialogue", "Mina Harker"],
      ["c3", "g6", 1, "announcer", "Announcer"],
      ["u1", "g7", 0, "dialogue", "Mina Harker"],
    ];
    for (const [ch, id, idx, kind, speaker] of lines) segment.run(id, `s-${ch}`, idx, kind, speaker, `key-${id}`, `/data/${id}.wav`);
  });

  const segments = () => db.prepare("SELECT id, cache_key AS key, audio_path AS path, duration_ms AS ms, status FROM segments ORDER BY id").all() as { id: string; key: string | null; status: string }[];
  const staleEpisodes = () => (db.prepare("SELECT chapter_id AS ch FROM episodes WHERE stale = 1 ORDER BY chapter_id").all() as { ch: string }[]).map((r) => r.ch);

  it("changes the voice, invalidates only that character's lines in that book, and marks their episodes stale", () => {
    const result = editCastVoices(db, "b1", PIN, [{ name: "Mina Harker", voiceId: "stub-f3", voiceFit: "fair" }]);
    expect(result).toEqual({ changed: ["Mina Harker"], segmentsInvalidated: 2, affectedChapterIds: ["c1", "c3"] });
    expect(loadCast(db, "b1")!.characters.find((c) => c.name === "Mina Harker")).toMatchObject({ voiceId: "stub-f3", voiceFit: "fair" });
    expect(loadCast(db, "b2")!.characters.find((c) => c.name === "Mina Harker")).toMatchObject({ voiceId: "stub-f1" });
    const after = Object.fromEntries(segments().map((s) => [s.id, s]));
    for (const id of ["g2", "g5"]) expect(after[id]).toEqual({ id, key: null, path: null, ms: null, status: "pending" });
    for (const id of ["g1", "g3", "g4", "g6", "g7"]) expect(after[id]).toMatchObject({ key: `key-${id}`, status: "rendered" });
    expect(staleEpisodes()).toEqual(["c1", "c3"]);
  });

  it("swaps two voices in one change", () => {
    const result = editCastVoices(db, "b1", PIN, [
      { name: "Mina Harker", voiceId: "stub-m2", voiceFit: "poor" },
      { name: "Count Dracula", voiceId: "stub-f1", voiceFit: "poor" },
    ]);
    expect(result).toEqual({ changed: ["Mina Harker", "Count Dracula"], segmentsInvalidated: 4, affectedChapterIds: ["c1", "c2", "c3"] });
    const voices = Object.fromEntries(loadCast(db, "b1")!.characters.map((c) => [c.name, c.voiceId]));
    expect(voices).toMatchObject({ "Mina Harker": "stub-m2", "Count Dracula": "stub-f1" });
  });

  it("does nothing for an edit that keeps the same voice", () => {
    expect(editCastVoices(db, "b1", PIN, [{ name: "Mina Harker", voiceId: "stub-f1", voiceFit: "good" }])).toEqual({ changed: [], segmentsInvalidated: 0, affectedChapterIds: [] });
    expect(segments().every((s) => s.status === "rendered")).toBe(true);
    expect(staleEpisodes()).toEqual([]);
  });

  it.each([
    ["a voice another character holds", [{ name: "Mina Harker", voiceId: "stub-m2", voiceFit: "poor" as const }]],
    ["the Announcer's voice", [{ name: "Mina Harker", voiceId: "stub-announcer", voiceFit: "poor" as const }]],
    ["the Narrator's voice", [{ name: "Mina Harker", voiceId: "stub-narrator", voiceFit: "poor" as const }]],
    ["an edit of the Announcer", [{ name: "Announcer", voiceId: "stub-f3", voiceFit: "poor" as const }]],
    ["an unknown character", [{ name: "Renfield", voiceId: "stub-f3", voiceFit: "poor" as const }]],
    ["a silent character", [{ name: "The landlady", voiceId: "stub-f3", voiceFit: "poor" as const }]],
    ["a character edited twice", [{ name: "Mina Harker", voiceId: "stub-f3", voiceFit: "fair" as const }, { name: "Mina Harker", voiceId: "stub-f4", voiceFit: "fair" as const }]],
    // The first change is valid; the second fails, so the first must be rolled back too.
    ["a valid change followed by a clash", [{ name: "Mina Harker", voiceId: "stub-f3", voiceFit: "fair" as const }, { name: "Count Dracula", voiceId: "stub-f3", voiceFit: "poor" as const }]],
  ])("refuses %s and changes nothing", (_label, changes) => {
    const before = loadCast(db, "b1");
    expect(() => editCastVoices(db, "b1", PIN, changes)).toThrow(CastConflictError);
    expect(loadCast(db, "b1")).toEqual(before);
    expect(segments().every((s) => s.status === "rendered")).toBe(true);
    expect(staleEpisodes()).toEqual([]);
  });

  it("refuses a stale pin", () => {
    expect(() => editCastVoices(db, "b1", { ...PIN, catalogueId: "other" }, [{ name: "Mina Harker", voiceId: "stub-f3", voiceFit: "fair" }])).toThrow(CastPinMismatchError);
  });
});
