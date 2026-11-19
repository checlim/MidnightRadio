import type { DatabaseSync } from "node:sqlite";
import { STUB_VOICE_CATALOGUE, CastingPausedError, buildCast, type ChunkCharacter } from "@midnight-radio/core";
import { BudgetLedger, CastFrozenError, loadCast, openDb, saveCast } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractCharacters } from "./casting.js";
import { StubLlmProvider } from "./stub.js";

/**
 * The casting pipeline end to end, with an offline model: extract characters, freeze the
 * inventory, assign voices, save the Cast. This is the sequence the `cast` job will run.
 */

const c = (name: string, extra: Partial<ChunkCharacter> = {}): ChunkCharacter => ({
  name,
  aliases: [],
  genderPresentation: "unstated",
  ageBand: "unknown",
  description: `${name} appears.`,
  speaks: true,
  ...extra,
});
const chapters = [
  { idx: 0, canonicalText: "Jonathan Harker met Count Dracula. “Welcome,” said the Count. The landlady crossed herself. Jonathan wrote home." },
  { idx: 1, canonicalText: "Mina Harker wrote to Lucy. Count Dracula watched Lucy. Mina replied." },
];
const model = new StubLlmProvider((req) =>
  JSON.stringify({
    characters: req.user.includes('chapter="1"')
      ? [
          c("Jonathan Harker", { aliases: ["Jonathan"], genderPresentation: "masculine", ageBand: "young-adult" }),
          c("Count Dracula", { aliases: ["the Count"], genderPresentation: "masculine", ageBand: "older" }),
          c("The landlady", { genderPresentation: "feminine", speaks: false }),
        ]
      : [c("Mina Harker", { genderPresentation: "feminine", ageBand: "young-adult" }), c("Lucy", { genderPresentation: "feminine", ageBand: "young-adult" }), c("Count Dracula", { aliases: ["the Count"] })],
  }),
);

let db: DatabaseSync;
let ledger: BudgetLedger;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'Dracula', 'h', 'ready', 0)").run();
  ledger = new BudgetLedger(db, { dailyTtsChars: 0, dailyLlmTokens: 1_000_000, bookTtsCharCeiling: 60_000 });
});
afterEach(() => db.close());

describe("casting pipeline", () => {
  it("extracts, assigns distinct voices, saves the Cast and reuses it unchanged", async () => {
    const { inventory } = await extractCharacters({ provider: model, ledger, bookId: "b1", chapters, delay: async () => undefined });
    const { pin, members } = buildCast(inventory, STUB_VOICE_CATALOGUE);
    saveCast(db, "b1", pin, members); // structural match with the db's CastMember is checked at compile time

    const cast = loadCast(db, "b1")!;
    expect(cast.pin.catalogueId).toBe("stub-voices-1");
    const names = cast.characters.map((m) => m.name);
    expect(names).toEqual(["Count Dracula", "Jonathan Harker", "Lucy", "Mina Harker", "The landlady"]);
    const voices = cast.characters.flatMap((m) => (m.voiceId ? [m.voiceId] : []));
    expect(voices).toHaveLength(4); // the landlady never speaks
    expect(new Set([...voices, cast.announcer.voiceId, cast.narrator.voiceId]).size).toBe(6); // all distinct
    expect(cast.characters.find((m) => m.name === "Count Dracula")).toMatchObject({ mentionCount: 3, voiceId: "stub-m2", ageBand: "older" });

    // Req 2.3: running casting again never reassigns.
    expect(() => saveCast(db, "b1", pin, members)).toThrow(CastFrozenError);
    expect(loadCast(db, "b1")).toEqual(cast);
  });

  it("is repeatable: the same inventory and catalogue give the same Cast, whatever order chunks were seen in", async () => {
    const run = async (chs: typeof chapters) => buildCast((await extractCharacters({ provider: model, ledger, bookId: "b1", chapters: chs, delay: async () => undefined })).inventory, STUB_VOICE_CATALOGUE);
    const a = await run(chapters);
    const reordered = await run([chapters[1]!, chapters[0]!]); // chapters processed in the opposite order
    // Voices depend on the frozen inventory, which holds the same characters either way.
    expect(a.members.map((m) => [m.name, m.voiceId])).toEqual(reordered.members.map((m) => [m.name, m.voiceId]));
  });

  it("pauses with a clear error before saving anything when voices run out", async () => {
    const crowd = new StubLlmProvider(() => JSON.stringify({ characters: Array.from({ length: 11 }, (_, i) => c(`Person ${String(i).padStart(2, "0")}`)) }));
    const { inventory } = await extractCharacters({ provider: crowd, ledger, bookId: "b1", chapters: [chapters[0]!], delay: async () => undefined });
    let paused: unknown;
    try {
      buildCast(inventory, STUB_VOICE_CATALOGUE);
    } catch (e) {
      paused = e;
    }
    expect(paused).toBeInstanceOf(CastingPausedError);
    expect(loadCast(db, "b1")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) n FROM cast_members").get()).toEqual({ n: 0 });
  });
});
