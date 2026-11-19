import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CastFrozenError, loadCast, saveCast, writeCast, type CastMember } from "./cast.js";
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
  member("Count Dracula", { aliases: ["Dracula", "the Count"], genderPresentation: "masculine", ageBand: "older", voiceId: "stub-m2", voiceFit: "good", mentionCount: 210, speaks: true }),
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
