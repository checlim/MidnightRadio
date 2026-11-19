import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ChunkExtractionSchema, buildInventory, countMentions, mergeCharacterEvidence, nameKey, type ChunkCharacter, type ChunkEvidence } from "./cast.js";

const ch = (name: string, extra: Partial<ChunkCharacter> = {}): ChunkCharacter => ({
  name,
  aliases: [],
  genderPresentation: "unstated",
  ageBand: "unknown",
  description: `${name} appears.`,
  speaks: false,
  ...extra,
});
const ev = (chunk: number, characters: ChunkCharacter[], chapterIdx = chunk): ChunkEvidence => ({ chunk, chapterIdx, characters });

describe("ChunkExtractionSchema", () => {
  it("accepts a well-formed report and rejects extra fields, blanks and bad enums", () => {
    expect(ChunkExtractionSchema.safeParse({ characters: [ch("Mina")] }).success).toBe(true);
    expect(ChunkExtractionSchema.safeParse({ characters: [{ ...ch("Mina"), mentionCount: 9 }] }).success).toBe(false);
    expect(ChunkExtractionSchema.safeParse({ characters: [ch("  ")] }).success).toBe(false);
    expect(ChunkExtractionSchema.safeParse({ characters: [{ ...ch("Mina"), ageBand: "ancient" }] }).success).toBe(false);
  });
});

describe("nameKey", () => {
  it("ignores case, spacing, curly apostrophes and a leading 'the'", () => {
    expect(nameKey("  The   Count ")).toBe("count");
    expect(nameKey("Harker’s wife")).toBe(nameKey("harker's wife"));
  });
});

describe("mergeCharacterEvidence", () => {
  it("merges reports that share a name or link through an alias", () => {
    const inv = mergeCharacterEvidence([
      ev(0, [ch("Count Dracula", { aliases: ["the Count", "Dracula"] })]),
      ev(1, [ch("Dracula", { aliases: ["Count Dracula"] })]),
      ev(2, [ch("The Count")]),
      ev(3, [ch("Count Dracula", { speaks: true })]),
      ev(4, [ch("the Count", { aliases: ["Dracula"] })]), // linked only through the shared alias
    ]);
    expect(inv).toHaveLength(1);
    // Aliases are sorted by name key ("count", "dracula").
    expect(inv[0]).toMatchObject({ id: "ch-count-dracula", name: "Count Dracula", aliases: ["the Count", "Dracula"], speaks: true, firstChapterIdx: 0 });
  });

  it("merges names that only share an alias when they never appear side by side", () => {
    const inv = mergeCharacterEvidence([ev(0, [ch("Count Dracula", { aliases: ["Dracula"] })]), ev(5, [ch("the Count", { aliases: ["Dracula"] })])]);
    expect(inv.map((c) => [c.name, c.aliases])).toEqual([["Count Dracula", ["the Count", "Dracula"]]]);
  });

  it("keeps characters apart across chunks once any chunk lists them side by side", () => {
    const inv = mergeCharacterEvidence([
      ev(0, [ch("Jonathan Harker", { aliases: ["Harker"] }), ch("Mina Harker", { aliases: ["Harker"] })]),
      ev(1, [ch("Harker")]), // which Harker? left as its own entry rather than guessed
    ]);
    expect(inv.map((c) => c.name)).toEqual(["Harker", "Jonathan Harker", "Mina Harker"]);
    expect(inv.every((c) => !c.aliases.includes("Harker"))).toBe(true);
  });

  it("never merges two characters through an alias they share, and drops that alias", () => {
    const inv = mergeCharacterEvidence([
      ev(0, [ch("Jonathan Harker", { aliases: ["Jonathan", "Harker"] }), ch("Mina Harker", { aliases: ["Mina", "Mrs. Harker", "Harker"] })]),
    ]);
    expect(inv.map((c) => [c.name, c.aliases])).toEqual([
      ["Jonathan Harker", ["Jonathan"]],
      ["Mina Harker", ["Mina", "Mrs. Harker"]],
    ]);
  });

  it("takes the description from the earliest appearance, whatever order chunks are processed in", () => {
    const early = ev(0, [ch("Lucy", { description: "Mina's cheerful friend." })]);
    const late = ev(9, [ch("Lucy", { description: "Lucy, now a vampire, stalks children." })]);
    for (const order of [[early, late], [late, early]]) expect(mergeCharacterEvidence(order)[0]!.description).toBe("Mina's cheerful friend.");
  });

  it("uses the majority of stated gender and age, and 'unstated'/'unknown' on a tie or when never stated", () => {
    const g = (genderPresentation: ChunkCharacter["genderPresentation"], ageBand: ChunkCharacter["ageBand"] = "unknown") => ch("Van Helsing", { genderPresentation, ageBand });
    expect(mergeCharacterEvidence([ev(0, [g("masculine", "older")]), ev(1, [g("unstated")]), ev(2, [g("masculine", "older")])])[0]).toMatchObject({ genderPresentation: "masculine", ageBand: "older" });
    expect(mergeCharacterEvidence([ev(0, [g("masculine")]), ev(1, [g("feminine")])])[0]!.genderPresentation).toBe("unstated");
    expect(mergeCharacterEvidence([ev(0, [g("unstated")])])[0]).toMatchObject({ genderPresentation: "unstated", ageBand: "unknown" });
  });

  it("gives unique, name-derived ids", () => {
    const inv = mergeCharacterEvidence([ev(0, [ch("Mr. Swales"), ch("Mr Swales!")])]);
    expect(inv.map((c) => c.id)).toEqual(["ch-mr-swales", "ch-mr-swales-2"]);
  });

  it("property: the result does not depend on chunk or character order", () => {
    const names = ["Jonathan Harker", "Mina Harker", "Count Dracula", "Lucy Westenra", "Van Helsing", "Dr. Seward", "Renfield"];
    const character = fc.record({
      name: fc.constantFrom(...names, "Dracula", "the Count", "Jonathan", "Mina", "Lucy"),
      aliases: fc.array(fc.constantFrom("Harker", "the Count", "Dracula", "Jonathan", "Mina", "Count Dracula", "Lucy", "the Professor", "Seward"), { maxLength: 3 }),
      genderPresentation: fc.constantFrom("feminine", "masculine", "neutral", "unstated"),
      ageBand: fc.constantFrom("child", "teen", "young-adult", "adult", "older", "unknown"),
      description: fc.constantFrom("A traveller.", "A friend.", "A host.", "A doctor of some kind."),
      speaks: fc.boolean(),
    }) as fc.Arbitrary<ChunkCharacter>;
    const evidence = fc.array(fc.array(character, { maxLength: 5 }), { maxLength: 8 }).map((chunks) => chunks.map((cs, i) => ev(i, cs, Math.floor(i / 2))));
    fc.assert(
      fc.property(evidence, fc.infiniteStream(fc.nat()), (e, rnd) => {
        const r = rnd[Symbol.iterator]();
        const shuffle = <T>(xs: T[]) => xs.map((x) => [r.next().value as number, x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
        const shuffled = shuffle(e).map((x) => ({ ...x, characters: shuffle(x.characters) }));
        expect(mergeCharacterEvidence(shuffled)).toEqual(mergeCharacterEvidence(e));
      }),
      { numRuns: 300 },
    );
  });
});

describe("countMentions", () => {
  const cast = [
    { id: "d", name: "Count Dracula", aliases: ["Dracula", "the Count"] },
    { id: "j", name: "Jonathan Harker", aliases: ["Jonathan", "Mr. Harker"] },
    { id: "m", name: "Mina Harker", aliases: ["Mina", "Mrs. Harker"] },
  ];

  it("counts whole words, longest first, case-sensitively, without double counting", () => {
    const text = "Count Dracula greeted Jonathan. “I am Dracula,” said the Count. The Count smiled. Do not count on it. Draculas? Mr. Harker and Mrs. Harker; Mina’s letter. Jonathan Harker’s journal.";
    expect(Object.fromEntries(countMentions([text], cast))).toEqual({ d: 4, j: 3, m: 2 });
  });

  it("does not count a name shared by two characters for either", () => {
    const counts = countMentions(["Harker wrote. Harker replied."], [
      { id: "a", name: "Jonathan Harker", aliases: ["Harker"] },
      { id: "b", name: "Mina Harker", aliases: ["Harker"] },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ a: 0, b: 0 });
  });

  it("matches across line breaks and curly apostrophes", () => {
    expect(countMentions(["Mr.\nHarker", "O’Brien and O'Brien"], [{ id: "j", name: "Mr. Harker", aliases: [] }, { id: "o", name: "O'Brien", aliases: [] }]).get("o")).toBe(2);
  });
});

describe("buildInventory", () => {
  it("attaches source-derived counts and ignores anything the model might claim", () => {
    const inv = buildInventory([ev(0, [ch("Renfield", { speaks: true })])], ["Renfield ate flies. Renfield laughed."]);
    expect(inv).toEqual([expect.objectContaining({ id: "ch-renfield", mentionCount: 2 })]);
  });
});
