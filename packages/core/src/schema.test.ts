import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LIMITS, ScriptSchema, scriptJsonSchema, type Script } from "./schema.js";

const valid = (): Script => ({
  bookId: "b1",
  chapterId: "c1",
  episodeNumber: 1,
  coldOpen: [
    { kind: "announcer", text: "Good evening, listeners." },
    { kind: "music", cue: "theme" },
  ],
  scenes: [
    {
      id: "s1",
      ambience: { kind: "sfx", id: "rain", gainDb: -14 },
      segments: [
        { kind: "narration", text: "A door creaks." },
        { kind: "dialogue", speaker: "Dracula", text: "Welcome.", delivery: "sinister" },
        { kind: "sfx", sfxId: "door_creak" },
        { kind: "pause", ms: 400 },
      ],
    },
  ],
  close: [
    { kind: "announcer", text: "Tune in next time to Midnight Radio." },
    { kind: "music", cue: "theme" },
  ],
});

const clone = <T>(v: T): T => structuredClone(v);

describe("ScriptSchema", () => {
  it("accepts a valid script", () => {
    expect(ScriptSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects unknown fields, including sourceSpan on segments", () => {
    const s = clone(valid()) as any;
    s.scenes[0].segments[0].sourceSpan = [0, 10];
    expect(ScriptSchema.safeParse(s).success).toBe(false);
    expect(ScriptSchema.safeParse({ ...valid(), extra: 1 }).success).toBe(false);
  });

  it("rejects empty scenes, segment lists and whitespace-only text", () => {
    expect(ScriptSchema.safeParse({ ...valid(), scenes: [] }).success).toBe(false);
    const empty = clone(valid());
    empty.scenes[0]!.segments = [];
    expect(ScriptSchema.safeParse(empty).success).toBe(false);
    const blank = clone(valid());
    blank.scenes[0]!.segments[0] = { kind: "narration", text: "   " };
    expect(ScriptSchema.safeParse(blank).success).toBe(false);
  });

  it("rejects duplicate scene IDs", () => {
    const s = clone(valid());
    s.scenes.push(clone(s.scenes[0]!));
    expect(ScriptSchema.safeParse(s).success).toBe(false);
  });

  it("requires an announcer first in the cold open and an announcer plus theme in the close", () => {
    const a = clone(valid());
    a.coldOpen = [{ kind: "narration", text: "Hi" }];
    expect(ScriptSchema.safeParse(a).success).toBe(false);
    const b = clone(valid());
    b.close = [{ kind: "music", cue: "theme" }];
    expect(ScriptSchema.safeParse(b).success).toBe(false);
    const c = clone(valid());
    c.close = [{ kind: "announcer", text: "Tune in." }];
    expect(ScriptSchema.safeParse(c).success).toBe(false);
  });

  it("enforces duration and gain bounds", () => {
    const withSeg = (seg: unknown, bed?: unknown) => {
      const s = clone(valid()) as any;
      s.scenes[0].segments = [seg];
      if (bed) s.scenes[0].ambience = bed;
      return ScriptSchema.safeParse(s).success;
    };
    expect(withSeg({ kind: "pause", ms: 0 })).toBe(false);
    expect(withSeg({ kind: "pause", ms: -5 })).toBe(false);
    expect(withSeg({ kind: "pause", ms: 1.5 })).toBe(false);
    expect(withSeg({ kind: "pause", ms: LIMITS.maxPauseMs + 1 })).toBe(false);
    expect(withSeg({ kind: "sfx", sfxId: "x", durationMs: -1 })).toBe(false);
    expect(withSeg({ kind: "sfx", sfxId: "x", durationMs: Number.NaN })).toBe(false);
    expect(withSeg({ kind: "sfx", sfxId: "x", durationMs: Infinity })).toBe(false);
    const ok = { kind: "pause", ms: 100 };
    expect(withSeg(ok, { kind: "sfx", id: "r", gainDb: 1 })).toBe(false);
    expect(withSeg(ok, { kind: "sfx", id: "r", gainDb: -41 })).toBe(false);
    expect(withSeg(ok, { kind: "sfx", id: "r", gainDb: -40 })).toBe(true);
    expect(withSeg(ok, { kind: "sfx", id: "r", gainDb: 0 })).toBe(true);
  });

  it("property: any in-bound pause/gain combination parses; out-of-bound gain never does", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: LIMITS.maxPauseMs }),
        fc.double({ min: LIMITS.minGainDb, max: LIMITS.maxGainDb, noNaN: true }),
        (ms, gainDb) => {
          const s = clone(valid());
          s.scenes[0]!.segments = [{ kind: "pause", ms }];
          s.scenes[0]!.ambience = { kind: "sfx", id: "rain", gainDb };
          return ScriptSchema.safeParse(s).success;
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: 0.001, max: 1000, noNaN: true }),
          fc.double({ min: -1000, max: -40.001, noNaN: true }),
        ),
        (gainDb) => {
          const s = clone(valid());
          s.scenes[0]!.ambience = { kind: "sfx", id: "rain", gainDb };
          return !ScriptSchema.safeParse(s).success;
        },
      ),
    );
  });

  it("property: non-blank text always parses, blank text never does", () => {
    const base = (t: string) => {
      const s = clone(valid());
      s.scenes[0]!.segments = [{ kind: "dialogue", speaker: "A", text: t }];
      return ScriptSchema.safeParse(s).success;
    };
    fc.assert(fc.property(fc.string({ minLength: 1 }).filter((t) => t.trim().length > 0), (t) => base(t)));
    fc.assert(fc.property(fc.stringMatching(/^\s*$/), (t) => !base(t)));
  });
});

describe("scriptJsonSchema", () => {
  it("produces a JSON Schema object with no sourceSpan property", () => {
    const schema = scriptJsonSchema();
    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).not.toContain("sourceSpan");
  });
});
