import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ScriptSchema } from "./schema.js";
import { SfxCatalogueSchema, auditScriptSfx, auditScriptSfxJson, checkSceneBed, checkSfxSegment, indexSfx, resolveMusicCue, type SfxCatalogue, type SfxEntry } from "./sfx.js";

const H = "a".repeat(64);
const generated = { type: "generated", model: "MOSS-SoundEffect-v2.0", revision: "e35df4d", licence: "Apache-2.0", prompt: "A heavy door creaks open.", seed: 1940, originalSha256: "b".repeat(64), generatedAt: "2026-11-20T10:00:00Z" } as const;
const entry = (id: string, extra: Partial<SfxEntry> = {}): SfxEntry => ({
  id,
  kind: "sfx",
  title: id.replace(/_/g, " "),
  path: `foley/${id}.wav`,
  sha256: H,
  durationMs: 5000,
  loopable: false,
  peakDb: -1,
  tags: [],
  source: generated,
  ...extra,
});
const catalogue = (patch: Partial<SfxCatalogue> = {}): SfxCatalogue => ({
  version: 1,
  id: "midnight-radio-sfx-1",
  entries: [
    entry("door_creak"),
    entry("rain", { loopable: true, durationMs: 30_000, path: "beds/rain.wav" }),
    entry("main_theme", { kind: "music", path: "music/theme.wav", source: { type: "project", author: "Midnight Radio", licence: "CC0-1.0" } }),
    entry("organ_bed", { kind: "music", loopable: true, path: "music/organ_bed.wav", source: { type: "cc0", url: "https://freesound.org/s/1/", licence: "CC0-1.0" } }),
  ],
  musicCues: { theme: "main_theme" },
  ...patch,
});
const parse = (c: unknown) => SfxCatalogueSchema.safeParse(c);
const messages = (c: unknown) => {
  const r = parse(c);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("SfxCatalogueSchema", () => {
  it("accepts generated, CC0 and project-made assets with a pinned music cue", () => {
    expect(parse(catalogue()).success).toBe(true);
    expect(parse(catalogue({ musicCues: {} })).success).toBe(true); // cues may be pinned later
  });

  it("refuses licences that are not on the allowlist, including a found sound that is not CC0", () => {
    for (const licence of ["CC-BY-NC-4.0", "proprietary", "", "cc0-1.0"]) {
      expect(parse(catalogue({ entries: [entry("door_creak", { source: { ...generated, licence: licence as never } })], musicCues: {} })).success, licence).toBe(false);
      expect(parse(catalogue({ entries: [entry("door_creak", { source: { ...generated, licence: "MIT" } })], musicCues: {} })).success).toBe(true);
    }
    expect(parse(catalogue({ entries: [entry("x_y", { source: { type: "cc0", url: "https://freesound.org/s/1/", licence: "Apache-2.0" as never } })], musicCues: {} })).success).toBe(false);
    expect(parse(catalogue({ entries: [entry("x_y", { source: { type: "cc0", url: "http://freesound.org/s/1/", licence: "CC0-1.0" } })], musicCues: {} })).success).toBe(false);
  });

  it("requires full provenance for generated foley", () => {
    for (const field of ["model", "revision", "prompt", "seed", "originalSha256", "generatedAt"] as const) {
      const { [field]: _dropped, ...rest } = generated;
      expect(parse(catalogue({ entries: [entry("door_creak", { source: rest as never })], musicCues: {} })).success, field).toBe(false);
    }
    expect(parse(catalogue({ entries: [entry("door_creak", { source: { ...generated, generatedAt: "yesterday" } })], musicCues: {} })).success).toBe(false);
  });

  it.each([
    ["an absolute path", "/etc/passwd.wav"],
    ["a parent segment", "foley/../../secret.wav"],
    ["a dot segment", "foley/./x.wav"],
    ["an empty segment", "foley//x.wav"],
    ["a backslash", "foley\\x.wav"],
    ["another format", "foley/x.mp3"],
    ["upper case", "Foley/X.wav"],
  ])("refuses %s", (_label, path) => {
    expect(parse(catalogue({ entries: [entry("door_creak", { path })], musicCues: {} })).success).toBe(false);
  });

  it("refuses duplicate ids and files, unknown fields, bad ids and out-of-range values", () => {
    expect(messages(catalogue({ entries: [entry("door_creak"), entry("door_creak", { path: "foley/other.wav" })], musicCues: {} }))).toContain('duplicate sound id "door_creak"');
    expect(messages(catalogue({ entries: [entry("door_creak"), entry("door_slam", { path: "foley/door_creak.wav" })], musicCues: {} }))).toContain('two sounds share the file "foley/door_creak.wav"');
    const bad: Partial<SfxEntry>[] = [{ id: "Door" }, { durationMs: 50 }, { durationMs: 1.5 }, { peakDb: 1 }, { tags: ["a", "a"] }, { tags: ["Bad Tag"] }, { sha256: "XYZ" }, { extra: 1 } as never];
    for (const patch of bad) expect(parse(catalogue({ entries: [entry("door_creak", patch)], musicCues: {} })).success, JSON.stringify(patch)).toBe(false);
    expect(parse({ ...catalogue(), version: 2 }).success).toBe(false);
    expect(parse({ ...catalogue(), musicCues: { overture: "main_theme" } }).success).toBe(false);
  });

  it("refuses a music cue pinned to a missing asset or to a sound effect", () => {
    expect(messages(catalogue({ musicCues: { sting: "nope" } }))).toEqual(['music cue "sting" points to "nope", which is not in the catalogue']);
    expect(messages(catalogue({ musicCues: { transition: "door_creak" } }))).toEqual(['music cue "transition" points to "door_creak", which is not music']);
  });
});

describe("checking a Script's references", () => {
  const c = SfxCatalogueSchema.parse(catalogue());
  const index = indexSfx(c);

  it("discrete sounds must be sound effects that exist", () => {
    expect(checkSfxSegment(index, "door_creak")).toBeNull();
    expect(checkSfxSegment(index, "rain")).toBeNull(); // a bed may also be used as a one-off sound
    expect(checkSfxSegment(index, "nope")).toMatchObject({ code: "unknown_id" });
    expect(checkSfxSegment(index, "main_theme")).toMatchObject({ code: "wrong_kind" });
  });

  it("scene beds must exist, match the declared kind, and loop", () => {
    expect(checkSceneBed(index, { kind: "sfx", id: "rain" })).toBeNull();
    expect(checkSceneBed(index, { kind: "music", id: "organ_bed" })).toBeNull();
    expect(checkSceneBed(index, { kind: "sfx", id: "door_creak" })).toMatchObject({ code: "not_loopable" });
    expect(checkSceneBed(index, { kind: "music", id: "rain" })).toMatchObject({ code: "wrong_kind" });
    expect(checkSceneBed(index, { kind: "sfx", id: "organ_bed" })).toMatchObject({ code: "wrong_kind" });
    expect(checkSceneBed(index, { kind: "sfx", id: "nope" })).toMatchObject({ code: "unknown_id" });
  });

  it("music cues resolve only through the pinned map", () => {
    expect(resolveMusicCue(c, index, "theme")).toMatchObject({ id: "main_theme" });
    expect(resolveMusicCue(c, index, "sting")).toMatchObject({ code: "unmapped_cue", id: "sting" });
  });

  it("property: a bed is accepted exactly when it exists, has the declared kind and loops", () => {
    const arbEntry = fc.record({ id: fc.constantFrom("a_1", "b_2", "c_3", "d_4"), kind: fc.constantFrom("sfx", "music") as fc.Arbitrary<"sfx" | "music">, loopable: fc.boolean() });
    fc.assert(
      fc.property(fc.uniqueArray(arbEntry, { selector: (e) => e.id }), fc.constantFrom("a_1", "b_2", "c_3", "d_4", "zz"), fc.constantFrom("sfx", "music") as fc.Arbitrary<"sfx" | "music">, (entries, id, kind) => {
        const cat = SfxCatalogueSchema.parse(catalogue({ entries: entries.map((e) => entry(e.id, e)), musicCues: {} }));
        const found = entries.find((e) => e.id === id);
        const ok = found !== undefined && found.kind === kind && found.loopable;
        expect(checkSceneBed(indexSfx(cat), { kind, id }) === null).toBe(ok);
      }),
      { numRuns: 300 },
    );
  });
});

describe("auditScriptSfx", () => {
  const c = SfxCatalogueSchema.parse(catalogue());
  const script = (patch: Record<string, unknown> = {}) => ({
    bookId: "dracula",
    chapterId: "ch1",
    episodeNumber: 1,
    coldOpen: [{ kind: "announcer", text: "Good evening." }, { kind: "music", cue: "theme", durationMs: 4000 }],
    scenes: [
      {
        id: "s1",
        ambience: { kind: "sfx", id: "rain" },
        segments: [{ kind: "narration", text: "The door opened." }, { kind: "sfx", sfxId: "door_creak", durationMs: 3000 }, { kind: "dialogue", speaker: "Count Dracula", text: "Welcome." }],
      },
    ],
    close: [{ kind: "announcer", text: "Tune in next time." }, { kind: "music", cue: "theme" }],
    ...patch,
  });
  const audit = (s: unknown) => auditScriptSfxJson(c, JSON.stringify(s));

  it("passes a Script whose sounds all resolve", () => {
    expect(audit(script())).toEqual({ schemaErrors: [], issues: [] });
    expect(auditScriptSfx(c, ScriptSchema.parse(script()))).toEqual([]);
  });

  it("reports every unusable reference with where it is", () => {
    const s = script({
      coldOpen: [{ kind: "announcer", text: "Good evening." }, { kind: "music", cue: "sting" }],
      scenes: [
        { id: "s1", ambience: { kind: "sfx", id: "door_creak" }, segments: [{ kind: "sfx", sfxId: "lightning" }, { kind: "sfx", sfxId: "main_theme" }] },
        { id: "s2", ambience: { kind: "music", id: "rain" }, segments: [{ kind: "sfx", sfxId: "door_creak", durationMs: 9000 }, { kind: "sfx", sfxId: "rain", durationMs: 60_000 }] },
      ],
    });
    expect(audit(s).issues.map((i) => [i.path, i.code, i.id])).toEqual([
      ["coldOpen[1]", "unmapped_cue", "sting"],
      ["scenes[0].ambience", "not_loopable", "door_creak"],
      ["scenes[0].segments[0]", "unknown_id", "lightning"],
      ["scenes[0].segments[1]", "wrong_kind", "main_theme"],
      ["scenes[1].ambience", "wrong_kind", "rain"],
      ["scenes[1].segments[0]", "longer_than_asset", "door_creak"],
      // rain loops, so it may run longer than its file
    ]);
    expect(audit(s).issues.find((i) => i.code === "longer_than_asset")!.message).toBe('"door_creak" lasts 5000 ms and cannot loop, but 9000 ms were asked for');
  });

  it("checks music cue durations against the pinned asset", () => {
    const s = script({ coldOpen: [{ kind: "announcer", text: "Good evening." }, { kind: "music", cue: "theme", durationMs: 6000 }] });
    expect(audit(s).issues).toEqual([expect.objectContaining({ path: "coldOpen[1]", code: "longer_than_asset", id: "main_theme" })]);
  });

  it("reports schema errors instead of checking sounds when the Script is malformed", () => {
    expect(audit({ ...script(), close: [{ kind: "announcer", text: "Bye." }] }).schemaErrors).toEqual(["close: close must contain a theme music cue"]);
    expect(audit({ ...script(), scenes: [] }).schemaErrors[0]).toMatch(/^scenes:/);
    expect(auditScriptSfxJson(c, "{not json")).toEqual({ schemaErrors: ["the Script is not valid JSON"], issues: [] });
  });
});
