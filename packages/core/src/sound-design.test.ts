import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Script } from "./schema.js";
import type { SfxCatalogue } from "./sfx.js";
import { applySoundDesign, checkOnlySoundAdded, checkSpeechUnchanged, evidenceInChapter, stripUnavailableSound, validateCues } from "./sound-design.js";

const entry = (id: string, kind: "sfx" | "music", loopable: boolean, durationMs = 3000) => ({ id, kind, title: id, path: `${kind}/${id}.wav`, sha256: "a".repeat(64), durationMs, loopable, peakDb: -1, tags: [], source: { type: "project" as const, author: "x", licence: "CC0-1.0" as const } });
const LIB: SfxCatalogue = {
  version: 1,
  id: "lib",
  entries: [entry("door_creak", "sfx", false, 2000), entry("rain_bed", "sfx", true, 8000), entry("wolf_howl", "sfx", false, 4000), entry("theme_x", "music", false, 20000)],
  musicCues: { theme: "theme_x" },
};
const CHAPTER = "The door creaked open. Outside, the rain fell on the old castle, and far off a wolf howled. “Welcome to my house!” said the Count.";
const SCRIPT: Script = {
  bookId: "b",
  chapterId: "c",
  episodeNumber: 1,
  coldOpen: [{ kind: "announcer", text: "Good evening. This is Midnight Radio." }, { kind: "music", cue: "theme" }],
  scenes: [
    {
      id: "door",
      title: "The castle door",
      segments: [
        { kind: "narration", text: "A door opens on a dark hall." },
        { kind: "dialogue", speaker: "Count Dracula", text: "Welcome to my house!", delivery: "sinister" },
        { kind: "pause", ms: 800 },
        { kind: "narration", text: "Far off, a wolf answers." },
      ],
    },
  ],
  close: [{ kind: "announcer", text: "Tune in next time to Midnight Radio." }, { kind: "music", cue: "theme" }],
};

describe("evidence", () => {
  it("must be at least two words that appear in the chapter, ignoring case and punctuation", () => {
    expect(evidenceInChapter("the door creaked open", CHAPTER)).toBe(true);
    expect(evidenceInChapter("Rain fell on the OLD castle", CHAPTER)).toBe(true);
    expect(evidenceInChapter("thunder rolled", CHAPTER)).toBe(false);
    expect(evidenceInChapter("door", CHAPTER)).toBe(false);
    expect(evidenceInChapter("door open", CHAPTER)).toBe(false); // not word for word
  });
});

describe("applying a sound-design pass", () => {
  it("inserts sounds and starts backgrounds at scene splits, and changes nothing spoken", () => {
    const r = applySoundDesign(
      SCRIPT,
      {
        cues: [
          { scene: 0, beforeSegment: 0, sfxId: "door_creak", evidence: "The door creaked open" },
          { scene: 0, beforeSegment: 3, sfxId: "wolf_howl", durationMs: 3000, evidence: "far off a wolf howled" },
        ],
        ambience: [{ scene: 0, fromSegment: 1, id: "rain_bed", gainDb: -18, evidence: "the rain fell on the old castle" }],
      },
      LIB,
      CHAPTER,
    );
    expect(r.rejected).toEqual([]);
    expect(r.script.scenes.map((s) => [s.id, s.title, s.ambience, s.segments.map((x) => x.kind)])).toEqual([
      ["door", "The castle door", undefined, ["sfx", "narration"]],
      ["door-2", undefined, { kind: "sfx", id: "rain_bed", gainDb: -18 }, ["dialogue", "pause", "sfx", "narration"]],
    ]);
    expect(r.cues).toEqual([
      { path: "scenes[0].segments[0]", sfxId: "door_creak", evidence: "The door creaked open" },
      { path: "scenes[1].segments[2]", sfxId: "wolf_howl", evidence: "far off a wolf howled" },
    ]);
    expect([...r.speechMap]).toEqual([
      ["coldOpen[0]", "coldOpen[0]"],
      ["scenes[0].segments[0]", "scenes[0].segments[1]"],
      ["scenes[0].segments[1]", "scenes[1].segments[0]"],
      ["scenes[0].segments[3]", "scenes[1].segments[3]"],
      ["close[0]", "close[0]"],
    ]);
    expect(validateCues(LIB, r.script)).toEqual([]);
  });

  it("drops what the text does not support or the library cannot play, and says why", () => {
    const r = applySoundDesign(
      SCRIPT,
      {
        cues: [
          { scene: 0, beforeSegment: 1, sfxId: "thunder", evidence: "the rain fell" },
          { scene: 0, beforeSegment: 1, sfxId: "door_creak", evidence: "thunder rolled overhead" },
          { scene: 0, beforeSegment: 1, sfxId: "theme_x", evidence: "the rain fell" },
          { scene: 0, beforeSegment: 1, sfxId: "door_creak", durationMs: 5000, evidence: "The door creaked open" },
          { scene: 3, beforeSegment: 0, sfxId: "door_creak", evidence: "The door creaked open" },
          { scene: 0, beforeSegment: 9, sfxId: "door_creak", evidence: "The door creaked open" },
        ],
        ambience: [
          { scene: 0, fromSegment: 0, id: "door_creak", evidence: "The door creaked open" },
          { scene: 0, fromSegment: 4, id: "rain_bed", evidence: "the rain fell" },
          { scene: 0, fromSegment: 1, id: "rain_bed", evidence: "a storm raged" },
        ],
      },
      LIB,
      CHAPTER,
    );
    expect(r.script).toEqual(SCRIPT);
    expect(r.rejected.map((x) => [x.edit, x.index, x.reason])).toEqual([
      ["cue", 0, '"thunder" is not in the sound library'],
      ["cue", 1, "its quote is not in the chapter, so the sound is not supported by the text"],
      ["cue", 2, '"theme_x" is music, not a sound effect'],
      ["cue", 3, '"door_creak" lasts 2000 ms and cannot loop'],
      ["cue", 4, "there is no scene 3"],
      ["cue", 5, "scene 0 has no segment 9"],
      ["ambience", 0, '"door_creak" cannot loop, so it cannot be a background'],
      ["ambience", 1, "scene 0 has no segment 4 to start a background at"],
      ["ambience", 2, "its quote is not in the chapter, so the background is not supported by the text"],
    ]);
  });

  it("never changes speech, music or pauses, whatever is proposed (property)", () => {
    const cue = fc.record({ scene: fc.nat(2), beforeSegment: fc.nat(6), sfxId: fc.constantFrom("door_creak", "wolf_howl", "rain_bed", "nope"), evidence: fc.constantFrom("The door creaked open", "far off a wolf howled", "made up words") });
    const bed = fc.record({ scene: fc.nat(2), fromSegment: fc.nat(5), id: fc.option(fc.constantFrom("rain_bed", "door_creak"), { nil: null }), evidence: fc.constantFrom("the rain fell", "nothing like it") });
    fc.assert(
      fc.property(fc.array(cue, { maxLength: 8 }), fc.array(bed, { maxLength: 4 }), (cues, ambience) => {
        const r = applySoundDesign(SCRIPT, { cues, ambience }, LIB, CHAPTER);
        const spoken = (s: Script) => [...s.coldOpen, ...s.scenes.flatMap((x) => x.segments), ...s.close].filter((x) => x.kind !== "sfx");
        expect(spoken(r.script)).toEqual(spoken(SCRIPT));
        expect(r.speechMap.size).toBe(5);
        expect(validateCues(LIB, r.script)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe("the speech check", () => {
  const variant = (f: (s: Script) => void) => {
    const s = structuredClone(SCRIPT);
    f(s);
    return s;
  };
  it("refuses any change to what is said, by whom, how, or in what order", () => {
    const cases: [string, Script][] = [
      ["rewritten", variant((s) => (s.scenes[0]!.segments[1] = { kind: "dialogue", speaker: "Count Dracula", text: "Welcome to my castle!", delivery: "sinister" }))],
      ["other speaker", variant((s) => (s.scenes[0]!.segments[1] = { kind: "dialogue", speaker: "Jonathan Harker", text: "Welcome to my house!", delivery: "sinister" }))],
      ["other delivery", variant((s) => (s.scenes[0]!.segments[1] = { kind: "dialogue", speaker: "Count Dracula", text: "Welcome to my house!", delivery: "warm" }))],
      ["dropped", variant((s) => s.scenes[0]!.segments.splice(3, 1))],
      ["duplicated", variant((s) => s.scenes[0]!.segments.push(s.scenes[0]!.segments[0]!))],
      ["reordered", variant((s) => s.scenes[0]!.segments.reverse())],
      ["music removed", variant((s) => s.close.pop())],
      ["pause changed", variant((s) => (s.scenes[0]!.segments[2] = { kind: "pause", ms: 200 }))],
    ];
    for (const [label, after] of cases) expect([label, checkOnlySoundAdded(SCRIPT, after).ok]).toEqual([label, false]);
    expect(checkOnlySoundAdded(SCRIPT, variant((s) => s.scenes[0]!.segments.splice(2, 0, { kind: "sfx", sfxId: "door_creak" }))).ok).toBe(true);
  });
});

describe("cue validation", () => {
  it("refuses unknown ids, music used as a sound, beds that cannot loop, and durations a recording cannot fill or that are too short", () => {
    const bad = structuredClone(SCRIPT);
    bad.scenes[0]!.ambience = { kind: "sfx", id: "door_creak" };
    bad.scenes[0]!.segments.push({ kind: "sfx", sfxId: "nope" }, { kind: "sfx", sfxId: "theme_x" }, { kind: "sfx", sfxId: "door_creak", durationMs: 9000 }, { kind: "sfx", sfxId: "rain_bed", durationMs: 40 });
    expect(validateCues(LIB, bad).map((i) => [i.code, i.path])).toEqual([
      ["not_loopable", "scenes[0].ambience"],
      ["unknown_id", "scenes[0].segments[4]"],
      ["wrong_kind", "scenes[0].segments[5]"],
      ["longer_than_asset", "scenes[0].segments[6]"],
      ["too_short", "scenes[0].segments[7]"],
    ]);
  });
});

describe("removing sounds a library no longer has", () => {
  it("drops unknown effects and backgrounds in scenes, keeps speech and music, and reports what went", () => {
    const old: Script = {
      ...SCRIPT,
      scenes: [{ ...SCRIPT.scenes[0]!, ambience: { kind: "sfx", id: "gone_bed" }, segments: [{ kind: "sfx", sfxId: "gone_knock" }, ...SCRIPT.scenes[0]!.segments, { kind: "sfx", sfxId: "door_creak" }] }],
    };
    const r = stripUnavailableSound(old, LIB);
    expect(r.removed.map((x) => [x.path, x.id])).toEqual([
      ["scenes[0].ambience", "gone_bed"],
      ["scenes[0].segments[0]", "gone_knock"],
    ]);
    expect(r.script.scenes[0]!.ambience).toBeUndefined();
    expect(r.script.scenes[0]!.segments).toEqual([...SCRIPT.scenes[0]!.segments, { kind: "sfx", sfxId: "door_creak" }]);
    expect(validateCues(LIB, r.script)).toEqual([]);
    expect(stripUnavailableSound(SCRIPT, LIB)).toEqual({ script: SCRIPT, removed: [] });
  });
});

describe("speech is unchanged", () => {
  const scene = SCRIPT.scenes[0]!;
  const withScenes = (segments: Script["scenes"][number]["segments"]): Script => ({ ...SCRIPT, scenes: [{ ...scene, segments }] });
  it("ignores sound effects and backgrounds, and catches any change to what is said, who says it, or how", () => {
    expect(checkSpeechUnchanged(SCRIPT, withScenes([{ kind: "sfx", sfxId: "door_creak" }, ...scene.segments]))).toEqual([]);
    expect(checkSpeechUnchanged(SCRIPT, { ...SCRIPT, scenes: [{ ...scene, ambience: { kind: "sfx", id: "rain_bed" } }] })).toEqual([]);
    const [n0, d1, p2, n3] = scene.segments as [never, { kind: "dialogue"; speaker: string; text: string; delivery: "sinister" }, never, never];
    for (const changed of [
      [n0, { ...d1, text: "Welcome!" }, p2, n3],
      [n0, { ...d1, speaker: "Jonathan Harker" }, p2, n3],
      [n0, { ...d1, delivery: "warm" as const }, p2, n3],
      [d1, n0, p2, n3],
      [n0, d1, d1, p2, n3],
      [n0, p2, n3],
      [n0, d1, n3],
    ]) {
      expect(checkSpeechUnchanged(SCRIPT, withScenes(changed as never)).length, JSON.stringify(changed)).toBeGreaterThan(0);
    }
    expect(checkSpeechUnchanged(SCRIPT, { ...SCRIPT, close: [SCRIPT.close[0]!] }).length).toBeGreaterThan(0);
  });
});
