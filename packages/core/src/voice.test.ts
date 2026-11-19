import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  CastingPausedError,
  STUB_VOICE_CATALOGUE,
  VoiceCatalogueSchema,
  assignVoices,
  assignableFrom,
  buildCast,
  catalogueHash,
  rateVoice,
  requireClonable,
  transcriptHash,
  type AssignableCharacter,
  type VoiceCatalogue,
} from "./voice.js";

const chr = (id: string, name: string, extra: Partial<AssignableCharacter> = {}): AssignableCharacter => ({
  id,
  name,
  genderPresentation: "unstated",
  ageBand: "unknown",
  speaks: true,
  mentionCount: 10,
  ...extra,
});
const voiceOf = (a: ReturnType<typeof assignVoices>, id: string) => a.characters.find((c) => c.characterId === id)!;
const cat = (patch: Partial<VoiceCatalogue> = {}): VoiceCatalogue => ({ ...STUB_VOICE_CATALOGUE, ...patch });

const cast: AssignableCharacter[] = [
  chr("ch-dracula", "Count Dracula", { genderPresentation: "masculine", ageBand: "older", mentionCount: 210 }),
  chr("ch-mina", "Mina Harker", { genderPresentation: "feminine", ageBand: "young-adult", mentionCount: 306 }),
  chr("ch-lucy", "Lucy Westenra", { genderPresentation: "feminine", ageBand: "young-adult", mentionCount: 299 }),
  chr("ch-jonathan", "Jonathan Harker", { genderPresentation: "masculine", ageBand: "young-adult", mentionCount: 205 }),
  chr("ch-helsing", "Van Helsing", { genderPresentation: "masculine", ageBand: "older", mentionCount: 470 }),
  chr("ch-renfield", "Renfield", { mentionCount: 48 }),
  chr("ch-landlady", "The landlady", { genderPresentation: "feminine", speaks: false, mentionCount: 2 }),
];

describe("VoiceCatalogueSchema", () => {
  it("accepts the stub catalogue", () => {
    expect(VoiceCatalogueSchema.safeParse(STUB_VOICE_CATALOGUE).success).toBe(true);
  });

  it.each([
    ["a duplicate voice id", (c: VoiceCatalogue) => ({ ...c, voices: [...c.voices, c.voices[3]!] })],
    ["an unknown reserved voice", (c: VoiceCatalogue) => ({ ...c, reserved: { ...c.reserved, narrator: "nope" } })],
    ["the same voice for Announcer and Narrator", (c: VoiceCatalogue) => ({ ...c, reserved: { announcer: "stub-f1", narrator: "stub-f1" } })],
    ["an unknown field", (c: VoiceCatalogue) => ({ ...c, extra: 1 })],
    ["an invalid voice id", (c: VoiceCatalogue) => ({ ...c, voices: [{ ...c.voices[0]!, id: "has space" }, ...c.voices.slice(1)] })],
    ["repeated age bands", (c: VoiceCatalogue) => ({ ...c, voices: [{ ...c.voices[2]!, ageBands: ["adult", "adult"] }, ...c.voices.slice(0, 2), ...c.voices.slice(3)] })],
  ])("rejects %s", (_label, mutate) => {
    expect(VoiceCatalogueSchema.safeParse(mutate(STUB_VOICE_CATALOGUE)).success).toBe(false);
  });
});

describe("catalogueHash", () => {
  it("does not depend on voice order, and changes with any pinned detail", () => {
    const base = catalogueHash(STUB_VOICE_CATALOGUE);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogueHash(cat({ voices: [...STUB_VOICE_CATALOGUE.voices].reverse() }))).toBe(base);
    expect(catalogueHash(cat({ seed: "other" }))).not.toBe(base);
    expect(catalogueHash(cat({ model: "stub-2" }))).not.toBe(base);
    const edited = STUB_VOICE_CATALOGUE.voices.map((v) => (v.id === "stub-f1" ? { ...v, gender: "masculine" as const } : v));
    expect(catalogueHash(cat({ voices: edited }))).not.toBe(base);
  });
});

describe("rateVoice", () => {
  const voice = (gender: "feminine" | "masculine" | "neutral", ageBands: ("adult" | "older")[] = []) => ({ id: "v", name: "V", gender, ageBands });
  it("grades gender and age", () => {
    expect(rateVoice({ genderPresentation: "feminine", ageBand: "adult" }, voice("feminine", ["adult"]))).toEqual({ score: 22, fit: "good" });
    expect(rateVoice({ genderPresentation: "feminine", ageBand: "adult" }, voice("feminine", ["older"]))).toEqual({ score: 20, fit: "fair" });
    expect(rateVoice({ genderPresentation: "feminine", ageBand: "adult" }, voice("neutral"))).toEqual({ score: 11, fit: "fair" });
    expect(rateVoice({ genderPresentation: "feminine", ageBand: "unknown" }, voice("masculine"))).toEqual({ score: 1, fit: "poor" });
    expect(rateVoice({ genderPresentation: "unstated", ageBand: "unknown" }, voice("masculine"))).toEqual({ score: 11, fit: "good" });
    expect(rateVoice({ genderPresentation: "neutral", ageBand: "unknown" }, voice("neutral"))).toEqual({ score: 21, fit: "good" });
  });
});

describe("assignVoices (Req 2.2, 2.6)", () => {
  const result = assignVoices(cast, STUB_VOICE_CATALOGUE);

  it("pins the catalogue and names the reserved voices", () => {
    expect(result).toMatchObject({ catalogueId: "stub-voices-1", announcerVoiceId: "stub-announcer", narratorVoiceId: "stub-narrator" });
    expect(result.catalogueHash).toBe(catalogueHash(STUB_VOICE_CATALOGUE));
  });

  it("never gives the Announcer or Narrator voice to a character, and never shares a voice", () => {
    const voices = result.characters.flatMap((c) => (c.voiceId ? [c.voiceId] : []));
    expect(voices).toHaveLength(6);
    expect(new Set(voices).size).toBe(voices.length);
    expect(voices).not.toContain("stub-announcer");
    expect(voices).not.toContain("stub-narrator");
  });

  it("lists characters most-mentioned first, and leaves non-speakers without a voice", () => {
    expect(result.characters.map((c) => c.characterId)).toEqual(["ch-helsing", "ch-mina", "ch-lucy", "ch-dracula", "ch-jonathan", "ch-renfield", "ch-landlady"]);
    expect(voiceOf(result, "ch-landlady")).toEqual({ characterId: "ch-landlady", voiceId: null, fit: null });
  });

  it("matches gender and age where the catalogue allows, giving the most mentioned first pick", () => {
    expect(voiceOf(result, "ch-helsing")).toMatchObject({ voiceId: "stub-m2", fit: "good" }); // masculine, older: only Felix fits both
    expect(voiceOf(result, "ch-dracula").voiceId).not.toBe("stub-m2"); // taken by Van Helsing
    expect(voiceOf(result, "ch-dracula")).toMatchObject({ voiceId: "stub-m1", fit: "fair" }); // masculine; best left, age off
    for (const id of ["ch-mina", "ch-lucy"]) expect(["stub-f1", "stub-f3"]).toContain(voiceOf(result, id).voiceId); // young-adult women
    expect(voiceOf(result, "ch-jonathan").voiceId).toMatch(/^stub-m/);
  });

  it("flags a poor fit rather than failing, when only mismatched voices remain", () => {
    const women = Array.from({ length: 5 }, (_, i) => chr(`w${i}`, `Woman ${i}`, { genderPresentation: "feminine", mentionCount: 50 - i }));
    const r = assignVoices(women, STUB_VOICE_CATALOGUE);
    expect(r.characters.map((c) => c.fit)).toEqual(["good", "good", "good", "good", "fair"]); // fifth gets a neutral voice
    const more = assignVoices([...women, ...Array.from({ length: 3 }, (_, i) => chr(`x${i}`, `Another ${i}`, { genderPresentation: "feminine", mentionCount: 1 }))], STUB_VOICE_CATALOGUE);
    expect(more.characters.at(-1)!.fit).toBe("poor");
  });

  it("does not depend on the order the characters are listed in", () => {
    const shuffles = [[...cast].reverse(), [cast[3]!, cast[0]!, cast[6]!, cast[1]!, cast[5]!, cast[2]!, cast[4]!], [...cast].sort((a, b) => a.name.localeCompare(b.name))];
    for (const order of shuffles) expect(assignVoices(order, STUB_VOICE_CATALOGUE)).toEqual(result);
  });

  it("does not depend on the order of voices in the catalogue", () => {
    expect(assignVoices(cast, cat({ voices: [...STUB_VOICE_CATALOGUE.voices].reverse() }))).toEqual(result);
  });

  it("breaks ties by the catalogue's seed: repeatable, and different seeds can differ", () => {
    const same = Array.from({ length: 6 }, (_, i) => chr(`s${i}`, `Speaker ${i}`, { mentionCount: 100 - i }));
    const pick = (seed: string) => assignVoices(same, cat({ seed })).characters.map((c) => c.voiceId);
    expect(pick("alpha")).toEqual(pick("alpha"));
    expect(new Set(["alpha", "beta", "gamma", "delta"].map((s) => pick(s).join(","))).size).toBeGreaterThan(1);
  });

  it("is unchanged by the mention counts' exact values, only their order", () => {
    const scaled = cast.map((c) => ({ ...c, mentionCount: c.mentionCount * 7 + 3 }));
    expect(assignVoices(scaled, STUB_VOICE_CATALOGUE)).toEqual(result);
  });

  it("works from a frozen inventory", () => {
    const inv = assignableFrom([
      { id: "ch-a", name: "A", aliases: [], genderPresentation: "masculine", ageBand: "adult", description: "x", speaks: true, mentionCount: 3, firstChapterIdx: 0 },
    ]);
    expect(assignVoices(inv, STUB_VOICE_CATALOGUE).characters).toEqual([{ characterId: "ch-a", voiceId: expect.stringMatching(/^stub-m/), fit: "good" }]);
  });

  it("assigns nothing for an empty or silent cast", () => {
    expect(assignVoices([], STUB_VOICE_CATALOGUE).characters).toEqual([]);
    expect(assignVoices([chr("a", "A", { speaks: false })], STUB_VOICE_CATALOGUE).characters).toEqual([{ characterId: "a", voiceId: null, fit: null }]);
  });
});

describe("buildCast", () => {
  const inventory = [
    { id: "ch-dracula", name: "Count Dracula", aliases: ["Dracula"], genderPresentation: "masculine" as const, ageBand: "older" as const, description: "A courteous old nobleman.", speaks: true, mentionCount: 210, firstChapterIdx: 0 },
    { id: "ch-landlady", name: "The landlady", aliases: [], genderPresentation: "feminine" as const, ageBand: "unknown" as const, description: "Warns Jonathan.", speaks: false, mentionCount: 2, firstChapterIdx: 0 },
  ];

  it("adds the Announcer and Narrator on their reserved voices, then the characters with their details", () => {
    const { pin, members } = buildCast(inventory, STUB_VOICE_CATALOGUE);
    expect(pin).toEqual({ catalogueId: "stub-voices-1", catalogueHash: catalogueHash(STUB_VOICE_CATALOGUE) });
    expect(members.map((m) => [m.role, m.name, m.voiceId])).toEqual([
      ["announcer", "Announcer", "stub-announcer"],
      ["narrator", "Narrator", "stub-narrator"],
      ["character", "Count Dracula", "stub-m2"],
      ["character", "The landlady", null],
    ]);
    expect(members[2]).toEqual({ name: "Count Dracula", role: "character", aliases: ["Dracula"], genderPresentation: "masculine", ageBand: "older", description: "A courteous old nobleman.", voiceId: "stub-m2", voiceFit: "good", mentionCount: 210, speaks: true });
  });

  it("pauses (and builds nothing) when voices run out", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...inventory[0]!, id: `c${i}`, name: `Speaker ${i}` }));
    expect(() => buildCast(many, STUB_VOICE_CATALOGUE)).toThrow(CastingPausedError);
  });
});

describe("pausing instead of sharing voices", () => {
  const speakers = (n: number) => Array.from({ length: n }, (_, i) => chr(`c${i}`, `Character ${String(i).padStart(2, "0")}`, { mentionCount: 1_000 - i }));

  it("fits exactly as many speakers as there are non-reserved voices", () => {
    const r = assignVoices(speakers(10), STUB_VOICE_CATALOGUE);
    expect(new Set(r.characters.map((c) => c.voiceId)).size).toBe(10);
  });

  it("pauses with a clear error, and assigns nobody, when speakers outnumber voices", () => {
    let error: unknown;
    try {
      assignVoices(speakers(12), STUB_VOICE_CATALOGUE);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CastingPausedError);
    const e = error as CastingPausedError;
    expect(e).toMatchObject({ reason: "voices_exhausted", details: { needed: 12, available: 10, names: ["Character 10", "Character 11"] } });
    expect(e.message).toMatch(/12 speaking characters.*only 10 voices left after the Announcer and Narrator/);
    expect(e.message).toMatch(/No voices are shared/);
  });

  it("counts only speakers, so silent characters never exhaust the catalogue", () => {
    const silent = Array.from({ length: 20 }, (_, i) => chr(`q${i}`, `Quiet ${i}`, { speaks: false, mentionCount: 0 }));
    expect(() => assignVoices([...speakers(10), ...silent], STUB_VOICE_CATALOGUE)).not.toThrow();
  });

  it.each(["Narrator", "the Announcer", "  NARRATOR "])("refuses a character named %j, which is reserved", (name) => {
    expect(() => assignVoices([chr("x", name)], STUB_VOICE_CATALOGUE)).toThrow(expect.objectContaining({ reason: "reserved_name" }));
  });

  it("refuses duplicate character ids and invalid catalogues", () => {
    expect(() => assignVoices([chr("x", "A"), chr("x", "B")], STUB_VOICE_CATALOGUE)).toThrow(expect.objectContaining({ reason: "duplicate_character" }));
    expect(() => assignVoices([chr("x", "A")], { ...STUB_VOICE_CATALOGUE, reserved: { announcer: "nope", narrator: "stub-narrator" } })).toThrow(/not in the catalogue/);
  });
});

describe("reference clips and pinned models (Req 5.5)", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const clip = (id: string) => ({ file: `clips/${id}.wav`, sha256: sha(id), transcript: "The night air is chill, and the hour is late." });
  const withClips = (patch: Partial<VoiceCatalogue> = {}): VoiceCatalogue => ({
    ...STUB_VOICE_CATALOGUE,
    ...patch,
    voices: STUB_VOICE_CATALOGUE.voices.map((v) => ({ ...v, description: `A designed voice for ${v.name}.`, clip: clip(v.id) })),
  });

  it("accepts a catalogue where every voice has a description and clip, and pinned models", () => {
    const models = [
      { role: "voice-design" as const, name: "Qwen3-TTS-12Hz-1.7B-VoiceDesign", revision: "abc123", weightsSha256: sha("design") },
      { role: "voice-clone" as const, name: "Qwen3-TTS-12Hz-1.7B-Base", revision: "fd4b254", weightsSha256: sha("base") },
    ];
    const c = withClips({ models });
    expect(VoiceCatalogueSchema.safeParse(c).success).toBe(true);
    expect(requireClonable(c).voices.every((v) => v.clip.file.endsWith(".wav"))).toBe(true);
  });

  it.each([
    ["a clip path that climbs out of the directory", { ...clip("x"), file: "../secrets/x.wav" }],
    ["an absolute clip path", { ...clip("x"), file: "/etc/x.wav" }],
    ["a clip that is not a .wav", { ...clip("x"), file: "clips/x.mp3" }],
    ["a clip path with a dot segment", { ...clip("x"), file: "clips/./x.wav" }],
    ["a clip with an empty segment", { ...clip("x"), file: "clips//x.wav" }],
    ["a malformed hash", { ...clip("x"), sha256: "ABC" }],
    ["a blank transcript", { ...clip("x"), transcript: "  " }],
    ["an unknown clip field", { ...clip("x"), duration: 5 }],
  ])("rejects %s", (_label, badClip) => {
    const c = withClips();
    c.voices = [{ ...c.voices[0]!, clip: badClip as never }, ...c.voices.slice(1)];
    expect(VoiceCatalogueSchema.safeParse(c).success).toBe(false);
  });

  it("rejects two entries for the same model role", () => {
    const c = withClips({ models: [{ role: "voice-clone", name: "A", revision: "1" }, { role: "voice-clone", name: "B", revision: "2" }] });
    expect(VoiceCatalogueSchema.safeParse(c).success).toBe(false);
  });

  it("pins the audio: changing a clip's hash or transcript, a description or a model changes the catalogue hash", () => {
    const base = catalogueHash(withClips({ models: [{ role: "voice-clone", name: "Base", revision: "1" }] }));
    const edit = (f: (c: VoiceCatalogue) => void, models?: VoiceCatalogue["models"]) => {
      const c = withClips(models ? { models } : { models: [{ role: "voice-clone", name: "Base", revision: "1" }] });
      f(c);
      return catalogueHash(c);
    };
    expect(edit(() => undefined)).toBe(base);
    expect(edit((c) => void (c.voices[3]!.clip!.sha256 = sha("re-recorded")))).not.toBe(base);
    expect(edit((c) => void (c.voices[3]!.clip!.transcript = "Another sentence entirely."))).not.toBe(base);
    expect(edit((c) => void (c.voices[3]!.description = "A different description."))).not.toBe(base);
    expect(edit(() => undefined, [{ role: "voice-clone", name: "Base", revision: "2" }])).not.toBe(base);
    expect(edit(() => undefined, [{ role: "voice-clone", name: "Base", revision: "1", weightsSha256: sha("w") }])).not.toBe(base);
  });

  it("does not depend on the order of the models", () => {
    const a = { role: "voice-design" as const, name: "D", revision: "1" };
    const b = { role: "voice-clone" as const, name: "C", revision: "1" };
    expect(catalogueHash(withClips({ models: [a, b] }))).toBe(catalogueHash(withClips({ models: [b, a] })));
  });

  it("requireClonable names the voices that lack a clip or description", () => {
    expect(() => requireClonable(STUB_VOICE_CATALOGUE)).toThrow(/voices without a reference clip and description: stub-announcer, stub-narrator/);
    const partial = withClips();
    delete partial.voices[5]!.clip;
    expect(() => requireClonable(partial)).toThrow(/stub-f4/);
  });

  it("hashes a transcript as UTF-8, matching the local audio service", () => {
    expect(transcriptHash("The night air is chill.")).toBe(sha("The night air is chill."));
    expect(transcriptHash("café “quoted”")).toBe(createHash("sha256").update(Buffer.from("café “quoted”", "utf8")).digest("hex"));
  });
});
