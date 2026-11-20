import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AGE_BANDS, GENDER_PRESENTATIONS, buildInventory, type ChunkCharacter, type ChunkEvidence } from "./cast.js";
import {
  CastingPausedError,
  STUB_VOICE_CATALOGUE,
  VOICE_AGE_BANDS,
  VOICE_GENDERS,
  assignVoices,
  buildCast,
  type AssignableCharacter,
  type VoiceCatalogue,
} from "./voice.js";

/**
 * Task 4.4 (Req 2.2, 2.6; design "Casting determinism"). Voice assignment is a function of the
 * frozen character inventory and the pinned catalogue only. These properties permute the same
 * inventory (they do not repeat an LLM extraction, which is not expected to be deterministic) and
 * check that the result is identical, that no character ever gets the Announcer's or Narrator's
 * voice, and that voices are never shared.
 */

const RUNS = { numRuns: 400 };

/** Seeded Fisher-Yates, so a failing case shrinks and replays exactly. */
const permute = <T>(xs: readonly T[], rnd: fc.Stream<number>): T[] => {
  const out = [...xs];
  const it = rnd[Symbol.iterator]();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (it.next().value as number) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/** Either the assignment or the pause, so outcomes can be compared whichever happened. */
function outcome<T>(fn: () => T): { ok: T } | { paused: Pick<CastingPausedError, "reason" | "details"> } {
  try {
    return { ok: fn() };
  } catch (err) {
    if (err instanceof CastingPausedError) return { paused: { reason: err.reason, details: err.details } };
    throw err;
  }
}

const NAMES = ["Mina Harker", "Lucy Westenra", "Count Dracula", "Jonathan Harker", "Van Helsing", "Renfield", "Dr. Seward", "Arthur Holmwood", "Quincey Morris", "Mr. Swales", "Sister Agatha", "The Captain", "Mrs. Westenra", "Bilder", "Hawkins", "The landlady"];

/** Characters with unique ids; names repeat sometimes and mention counts tie often, to exercise every tie-break. */
const inventory = (maxLength: number) =>
  fc
    .uniqueArray(
      fc.record({
        id: fc.integer({ min: 0, max: 99 }).map((n) => `ch-${n}`),
        name: fc.constantFrom(...NAMES),
        genderPresentation: fc.constantFrom(...GENDER_PRESENTATIONS),
        ageBand: fc.constantFrom(...AGE_BANDS),
        speaks: fc.boolean(),
        mentionCount: fc.oneof(fc.nat(3), fc.nat(500)),
      }),
      { selector: (c) => c.id, maxLength },
    )
    .map((cs) => cs as AssignableCharacter[]);

/** Any valid catalogue: 3–24 voices with random genders and ages, two of them reserved. */
const catalogue: fc.Arbitrary<VoiceCatalogue> = fc
  .uniqueArray(
    fc.record({
      id: fc.integer({ min: 0, max: 99 }).map((n) => `v-${n}`),
      gender: fc.constantFrom(...VOICE_GENDERS),
      ageBands: fc.subarray([...VOICE_AGE_BANDS]),
    }),
    { selector: (v) => v.id, minLength: 3, maxLength: 24 },
  )
  .chain((voices) =>
    fc.record({
      voices: fc.constant(voices.map((v) => ({ ...v, name: v.id }))),
      reserved: fc.uniqueArray(fc.constantFrom(...voices.map((v) => v.id)), { minLength: 2, maxLength: 2 }).map(([announcer, narrator]) => ({ announcer: announcer!, narrator: narrator! })),
      seed: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
    }),
  )
  .map(({ voices, reserved, seed }) => ({ id: "generated", provider: "test", model: "test-1", version: "1", seed, reserved, voices }));

describe("voice assignment (property-based, task 4.4)", () => {
  it("property: the same frozen inventory in any order gets exactly the same assignment, or the same pause", () => {
    fc.assert(
      fc.property(inventory(30), catalogue, fc.infiniteStream(fc.nat()), (chars, cat, rnd) => {
        expect(outcome(() => assignVoices(permute(chars, rnd), cat))).toEqual(outcome(() => assignVoices(chars, cat)));
      }),
      RUNS,
    );
  });

  it("property: the order of voices in the catalogue does not matter either", () => {
    fc.assert(
      fc.property(inventory(30), catalogue, fc.infiniteStream(fc.nat()), (chars, cat, rnd) => {
        const shuffled = { ...cat, voices: permute(cat.voices, rnd) };
        expect(outcome(() => assignVoices(chars, shuffled))).toEqual(outcome(() => assignVoices(chars, cat)));
      }),
      RUNS,
    );
  });

  it("property: speakers get distinct catalogue voices, never a reserved one; silent characters get none; too few voices pauses", () => {
    fc.assert(
      fc.property(inventory(30), catalogue, (chars, cat) => {
        const reserved = [cat.reserved.announcer, cat.reserved.narrator];
        const free = cat.voices.length - 2;
        const speakers = chars.filter((c) => c.speaks).length;
        const result = outcome(() => assignVoices(chars, cat));
        if (speakers > free) {
          expect(result).toEqual({ paused: { reason: "voices_exhausted", details: expect.objectContaining({ needed: speakers, available: free }) } });
          return;
        }
        if (!("ok" in result)) throw new Error(`unexpected pause: ${JSON.stringify(result)}`);
        const a = result.ok;
        expect([a.announcerVoiceId, a.narratorVoiceId]).toEqual(reserved);
        expect(a.characters.map((c) => c.characterId).sort()).toEqual(chars.map((c) => c.id).sort());
        const ids = new Set(cat.voices.map((v) => v.id));
        const byId = new Map(chars.map((c) => [c.id, c]));
        const held: string[] = [];
        for (const c of a.characters) {
          if (byId.get(c.characterId)!.speaks) {
            expect(c.voiceId).not.toBeNull();
            expect(ids.has(c.voiceId!)).toBe(true);
            expect(reserved).not.toContain(c.voiceId);
            held.push(c.voiceId!);
          } else {
            expect(c).toEqual({ characterId: c.characterId, voiceId: null, fit: null });
          }
        }
        expect(new Set(held).size).toBe(held.length);
      }),
      RUNS,
    );
  });

  it("property: a character named Announcer or Narrator is refused in any order, and never handed a reserved voice", () => {
    fc.assert(
      fc.property(inventory(8), fc.constantFrom("Announcer", "the Narrator", " NARRATOR ", "announcer"), fc.infiniteStream(fc.nat()), (chars, name, rnd) => {
        const withReserved = [...chars, { id: "ch-reserved", name, genderPresentation: "unstated", ageBand: "unknown", speaks: true, mentionCount: 1 } as AssignableCharacter];
        const result = outcome(() => assignVoices(permute(withReserved, rnd), STUB_VOICE_CATALOGUE));
        expect(result).toMatchObject({ paused: { reason: "reserved_name" } });
      }),
      RUNS,
    );
  });

  it("property: end to end, shuffling the order chapters and characters were discovered in gives the same stored Cast", () => {
    const character = fc.record({
      name: fc.constantFrom(...NAMES.slice(0, 10)),
      aliases: fc.array(fc.constantFrom("Harker", "the Count", "Dracula", "Mina", "the Professor", "Seward"), { maxLength: 2 }),
      genderPresentation: fc.constantFrom(...GENDER_PRESENTATIONS),
      ageBand: fc.constantFrom(...AGE_BANDS),
      description: fc.constantFrom("A traveller.", "A friend.", "A host."),
      speaks: fc.boolean(),
    }) as fc.Arbitrary<ChunkCharacter>;
    const evidence = fc
      .array(fc.array(character, { maxLength: 4 }), { maxLength: 8 })
      .map((chunks) => chunks.map((characters, i): ChunkEvidence => ({ chunk: i, chapterIdx: Math.floor(i / 2), characters })));
    // Chapter texts stay in book order: only the order of discovery changes.
    const texts = ["Mina Harker wrote to Lucy Westenra. The Count waited.", "Van Helsing and Dr. Seward spoke of Renfield. Harker slept.", "Mina, Mina! cried Jonathan Harker."];
    fc.assert(
      fc.property(evidence, fc.infiniteStream(fc.nat()), (e, rnd) => {
        const shuffled = permute(e, rnd).map((x) => ({ ...x, characters: permute(x.characters, rnd) }));
        const cast = (ev: ChunkEvidence[]) => outcome(() => buildCast(buildInventory(ev, texts), STUB_VOICE_CATALOGUE));
        const original = cast(e);
        expect(cast(shuffled)).toEqual(original);
        if ("ok" in original) {
          const characterVoices = original.ok.members.filter((m) => m.role === "character").flatMap((m) => (m.voiceId ? [m.voiceId] : []));
          expect(characterVoices).not.toContain(STUB_VOICE_CATALOGUE.reserved.announcer);
          expect(characterVoices).not.toContain(STUB_VOICE_CATALOGUE.reserved.narrator);
          expect(new Set(characterVoices).size).toBe(characterVoices.length);
        }
      }),
      RUNS,
    );
  });
});
