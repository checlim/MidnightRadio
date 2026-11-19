import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CastEditError, addToCast, planVoiceEdits, type FrozenCast, type NewCharacter } from "./cast-edit.js";
import { CastingPausedError, STUB_VOICE_CATALOGUE, buildCast, type CastRecord, type VoiceCatalogue } from "./voice.js";

const inv = (id: string, name: string, extra: Partial<NewCharacter> = {}): NewCharacter & { firstChapterIdx: number } => ({
  id,
  name,
  aliases: [],
  genderPresentation: "unstated",
  ageBand: "unknown",
  description: `${name} appears.`,
  speaks: true,
  mentionCount: 10,
  firstChapterIdx: 0,
  ...extra,
});

/** The stub catalogue has 10 character voices; this Cast uses 5 of them. */
function frozen(catalogue: VoiceCatalogue = STUB_VOICE_CATALOGUE): FrozenCast {
  const { pin, members } = buildCast(
    [
      inv("ch-helsing", "Van Helsing", { genderPresentation: "masculine", ageBand: "older", mentionCount: 470, aliases: ["the Professor"] }),
      inv("ch-mina", "Mina Harker", { genderPresentation: "feminine", ageBand: "young-adult", mentionCount: 306, aliases: ["Madam Mina"] }),
      inv("ch-dracula", "Count Dracula", { genderPresentation: "masculine", ageBand: "older", mentionCount: 210, aliases: ["the Count"] }),
      inv("ch-jonathan", "Jonathan Harker", { genderPresentation: "masculine", ageBand: "young-adult", mentionCount: 205 }),
      inv("ch-lucy", "Lucy Westenra", { genderPresentation: "feminine", ageBand: "young-adult", mentionCount: 299 }),
      inv("ch-landlady", "The landlady", { genderPresentation: "feminine", speaks: false, mentionCount: 2 }),
    ],
    catalogue,
  );
  return {
    pin,
    announcer: members.find((m) => m.role === "announcer")!,
    narrator: members.find((m) => m.role === "narrator")!,
    characters: members.filter((m) => m.role === "character"),
  };
}

const voiceOf = (records: CastRecord[], name: string) => records.find((r) => r.name === name)?.voiceId;
const usedVoices = (cast: FrozenCast) => [cast.announcer, cast.narrator, ...cast.characters].flatMap((m) => (m.voiceId ? [m.voiceId] : []));
const pauseOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof CastingPausedError) return err;
    throw err;
  }
  throw new Error("expected a CastingPausedError");
};
const editErrorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof CastEditError) return err;
    throw err;
  }
  throw new Error("expected a CastEditError");
};

describe("addToCast (Req 2.4)", () => {
  it("gives new speaking characters unused, non-reserved voices and silent ones none", () => {
    const cast = frozen();
    const added = addToCast(cast, [inv("ch-renfield", "Renfield", { genderPresentation: "masculine", ageBand: "adult", mentionCount: 48 }), inv("ch-swales", "Mr. Swales", { speaks: false })], STUB_VOICE_CATALOGUE);
    expect(added.map((a) => a.name)).toEqual(["Renfield", "Mr. Swales"]);
    const renfield = voiceOf(added, "Renfield")!;
    expect(usedVoices(cast)).not.toContain(renfield);
    expect(renfield).toMatch(/^stub-m/);
    expect(added[0]).toMatchObject({ role: "character", voiceFit: expect.stringMatching(/^(good|fair)$/), speaks: true, description: "Renfield appears." });
    expect(added[1]).toMatchObject({ voiceId: null, voiceFit: null, speaks: false });
  });

  it("follows the same rules as first casting: the newcomer gets the voice it would have had if no one else needed it", () => {
    // With the whole cast at once, Renfield (fewest mentions) is served last. Added later, he gets
    // the best voice still free, which is the same voice, because the rest of the Cast is unchanged.
    const all = buildCast(
      [...frozen().characters.map((c, i) => inv(`ch-${i}`, c.name, { genderPresentation: c.genderPresentation as never, ageBand: c.ageBand as never, mentionCount: c.mentionCount, speaks: c.speaks })), inv("ch-renfield", "Renfield", { mentionCount: 1 })],
      STUB_VOICE_CATALOGUE,
    );
    const later = addToCast(frozen(), [inv("ch-renfield", "Renfield", { mentionCount: 1 })], STUB_VOICE_CATALOGUE);
    expect(voiceOf(later, "Renfield")).toBe(voiceOf(all.members, "Renfield"));
  });

  it("refuses a name or alias already in the Cast, a reserved name, and a newcomer listed twice", () => {
    const cast = frozen();
    for (const name of ["Mina Harker", "mina  harker", "Madam Mina", "the Count", "landlady"]) {
      expect(pauseOf(() => addToCast(cast, [inv("x", name)], STUB_VOICE_CATALOGUE)).reason).toBe("duplicate_character");
    }
    expect(pauseOf(() => addToCast(cast, [inv("a", "Renfield"), inv("b", "renfield")], STUB_VOICE_CATALOGUE)).reason).toBe("duplicate_character");
    expect(pauseOf(() => addToCast(cast, [inv("a", "Renfield"), inv("a", "Swales")], STUB_VOICE_CATALOGUE)).reason).toBe("duplicate_character");
    expect(pauseOf(() => addToCast(cast, [inv("x", "The Narrator")], STUB_VOICE_CATALOGUE)).reason).toBe("reserved_name");
  });

  it("drops a newcomer's aliases that already name someone in the Cast", () => {
    const [renfield] = addToCast(frozen(), [inv("ch-renfield", "Renfield", { aliases: ["the patient", "the Count", "Mina Harker"] })], STUB_VOICE_CATALOGUE);
    expect(renfield!.aliases).toEqual(["the patient"]);
  });

  it("pauses without adding anyone when there are not enough unused voices", () => {
    // 10 character voices, 5 taken: 6 new speakers is one too many.
    const newcomers = Array.from({ length: 6 }, (_, i) => inv(`n${i}`, `Sailor ${i}`, { mentionCount: 10 - i }));
    const err = pauseOf(() => addToCast(frozen(), newcomers, STUB_VOICE_CATALOGUE));
    expect(err).toMatchObject({ reason: "voices_exhausted", details: { needed: 6, available: 5, names: ["Sailor 5"] } });
    expect(err.message).toMatch(/Existing voices are kept and never shared/);
    expect(addToCast(frozen(), newcomers.slice(0, 5), STUB_VOICE_CATALOGUE)).toHaveLength(5);
    // Silent newcomers need no voice, so any number of them fit.
    expect(addToCast(frozen(), newcomers.map((c) => ({ ...c, speaks: false })), STUB_VOICE_CATALOGUE)).toHaveLength(6);
  });

  it("refuses a catalogue other than the pinned one, even one that only adds voices", () => {
    const bigger: VoiceCatalogue = { ...STUB_VOICE_CATALOGUE, voices: [...STUB_VOICE_CATALOGUE.voices, { id: "stub-m9", name: "Ivo", gender: "masculine", ageBands: ["adult"] }] };
    expect(pauseOf(() => addToCast(frozen(), [inv("x", "Renfield")], bigger)).reason).toBe("catalogue_changed");
    expect(pauseOf(() => addToCast(frozen(), [inv("x", "Renfield")], { ...STUB_VOICE_CATALOGUE, id: "other" })).reason).toBe("catalogue_changed");
  });

  it("property: newcomer voices are distinct, unused, never reserved, and independent of the order newcomers arrive in", () => {
    const newcomer = fc.record({
      name: fc.constantFrom("Renfield", "Swales", "Bilder", "Hawkins", "Sister Agatha", "The Captain", "Mrs. Westenra", "Lord Godalming", "The Mate"),
      genderPresentation: fc.constantFrom("feminine", "masculine", "neutral", "unstated"),
      ageBand: fc.constantFrom("child", "teen", "young-adult", "adult", "older", "unknown"),
      speaks: fc.boolean(),
      mentionCount: fc.nat(500),
    });
    fc.assert(
      fc.property(fc.uniqueArray(newcomer, { selector: (c) => c.name, maxLength: 9 }), fc.integer(), (list, seed) => {
        const cast = frozen();
        const newcomers = list.map((c, i) => inv(`n${i}`, c.name, { ...c } as Partial<NewCharacter>));
        const free = 10 - 5;
        const speakers = newcomers.filter((c) => c.speaks).length;
        if (speakers > free) {
          expect(pauseOf(() => addToCast(cast, newcomers, STUB_VOICE_CATALOGUE)).reason).toBe("voices_exhausted");
          return;
        }
        const added = addToCast(cast, newcomers, STUB_VOICE_CATALOGUE);
        const voices = added.flatMap((a) => (a.voiceId ? [a.voiceId] : []));
        expect(voices).toHaveLength(speakers);
        expect(new Set(voices).size).toBe(voices.length);
        for (const v of voices) {
          expect(usedVoices(cast)).not.toContain(v);
          expect([STUB_VOICE_CATALOGUE.reserved.announcer, STUB_VOICE_CATALOGUE.reserved.narrator]).not.toContain(v);
        }
        const shuffled = [...newcomers].sort((a, b) => ((a.id.charCodeAt(1) * 31 + seed) % 7) - ((b.id.charCodeAt(1) * 31 + seed) % 7));
        expect(addToCast(cast, shuffled, STUB_VOICE_CATALOGUE)).toEqual(added);
      }),
      { numRuns: 300 },
    );
  });
});

describe("planVoiceEdits (Req 2.5)", () => {
  it("reports only characters whose voice actually changes, with the new fit", () => {
    const cast = frozen();
    const free = STUB_VOICE_CATALOGUE.voices.find((v) => v.gender === "feminine" && !usedVoices(cast).includes(v.id))!.id;
    const mina = voiceOf(cast.characters, "Mina Harker")!;
    const changes = planVoiceEdits(cast, [{ name: "Mina Harker", voiceId: free }, { name: "Count Dracula", voiceId: voiceOf(cast.characters, "Count Dracula")! }], STUB_VOICE_CATALOGUE);
    expect(changes).toEqual([{ name: "Mina Harker", previousVoiceId: mina, voiceId: free, voiceFit: expect.stringMatching(/good|fair/) }]);
    expect(planVoiceEdits(cast, [], STUB_VOICE_CATALOGUE)).toEqual([]);
  });

  it("records a poor fit rather than refusing it: a person may choose a voice on purpose", () => {
    const cast = frozen();
    const masc = STUB_VOICE_CATALOGUE.voices.find((v) => v.gender === "masculine" && v.id.startsWith("stub-m") && !usedVoices(cast).includes(v.id))!.id;
    expect(planVoiceEdits(cast, [{ name: "mina harker", voiceId: masc }], STUB_VOICE_CATALOGUE)).toEqual([expect.objectContaining({ name: "Mina Harker", voiceFit: "poor" })]);
  });

  it("lets two characters swap voices in one change", () => {
    const cast = frozen();
    const mina = voiceOf(cast.characters, "Mina Harker")!;
    const lucy = voiceOf(cast.characters, "Lucy Westenra")!;
    const changes = planVoiceEdits(cast, [{ name: "Mina Harker", voiceId: lucy }, { name: "Lucy Westenra", voiceId: mina }], STUB_VOICE_CATALOGUE);
    expect(Object.fromEntries(changes.map((c) => [c.name, c.voiceId]))).toEqual({ "Mina Harker": lucy, "Lucy Westenra": mina });
  });

  it.each([
    ["a voice another character keeps", (c: FrozenCast) => [{ name: "Mina Harker", voiceId: voiceOf(c.characters, "Lucy Westenra")! }], "voice_taken"],
    ["two characters given one voice", () => [{ name: "Mina Harker", voiceId: "stub-f3" }, { name: "Lucy Westenra", voiceId: "stub-f3" }], "voice_taken"],
    ["the Announcer's voice", () => [{ name: "Mina Harker", voiceId: STUB_VOICE_CATALOGUE.reserved.announcer }], "reserved_voice"],
    ["the Narrator's voice", () => [{ name: "Mina Harker", voiceId: STUB_VOICE_CATALOGUE.reserved.narrator }], "reserved_voice"],
    ["a voice not in the catalogue", () => [{ name: "Mina Harker", voiceId: "stub-zz" }], "unknown_voice"],
    ["the Announcer itself", () => [{ name: "Announcer", voiceId: "stub-f3" }], "reserved_role"],
    ["the Narrator itself", () => [{ name: "the narrator", voiceId: "stub-f3" }], "reserved_role"],
    ["someone not in the Cast", () => [{ name: "Renfield", voiceId: "stub-f3" }], "unknown_character"],
    ["a character who never speaks", () => [{ name: "The landlady", voiceId: "stub-f3" }], "silent_character"],
    ["the same character twice", () => [{ name: "Mina Harker", voiceId: "stub-f3" }, { name: "MINA HARKER", voiceId: "stub-f4" }], "duplicate_edit"],
  ] as const)("refuses %s", (_label, edits, reason) => {
    const cast = frozen();
    expect(editErrorOf(() => planVoiceEdits(cast, edits(cast), STUB_VOICE_CATALOGUE)).reason).toBe(reason);
  });

  it("refuses a catalogue other than the pinned one", () => {
    expect(editErrorOf(() => planVoiceEdits(frozen(), [{ name: "Mina Harker", voiceId: "stub-f3" }], { ...STUB_VOICE_CATALOGUE, version: "2" })).reason).toBe("catalogue_changed");
  });

  it("property: after any accepted edit, voices stay distinct and away from the Announcer and Narrator", () => {
    const cast = frozen();
    const speakers = cast.characters.filter((c) => c.speaks).map((c) => c.name);
    const voiceIds = STUB_VOICE_CATALOGUE.voices.map((v) => v.id);
    fc.assert(
      fc.property(fc.array(fc.record({ name: fc.constantFrom(...speakers), voiceId: fc.constantFrom(...voiceIds) }), { maxLength: 5 }), (edits) => {
        let changes;
        try {
          changes = planVoiceEdits(cast, edits, STUB_VOICE_CATALOGUE);
        } catch (err) {
          expect(err).toBeInstanceOf(CastEditError);
          return;
        }
        const after = new Map(cast.characters.map((c) => [c.name, c.voiceId]));
        for (const c of changes) after.set(c.name, c.voiceId);
        const held = [...after.values()].filter((v): v is string => v !== null);
        expect(new Set(held).size).toBe(held.length);
        expect(held).not.toContain(cast.announcer.voiceId);
        expect(held).not.toContain(cast.narrator.voiceId);
        for (const c of changes) expect(c.voiceId).not.toBe(c.previousVoiceId);
      }),
      { numRuns: 500 },
    );
  });
});
