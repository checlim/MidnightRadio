import fc from "fast-check";
import type { Script, Segment } from "@midnight-radio/core";
import { describe, expect, it } from "vitest";
import { SAMPLE_RATE, TimelineError, buildTimeline, framesToMs, msToFrames, segmentsInOrder, speechRanges, type SegmentAudio } from "./timeline.js";

const sec = (s: number) => s * SAMPLE_RATE;
const TURN = msToFrames(250);
const SCENE = msToFrames(600);

/** Every speech line is 1 s, the door creak 2 s, the rain bed 10 s and loopable, the theme 3 s. */
const audio = (_ref: unknown, seg: Segment): SegmentAudio => {
  if (seg.kind === "sfx") return { asset: { path: `${seg.sfxId}.wav`, frames: seg.sfxId === "rain" ? sec(10) : sec(2), loopable: seg.sfxId === "rain" } };
  if (seg.kind === "music") return { asset: { path: `${seg.cue}.wav`, frames: sec(3), loopable: false } };
  return { speech: { path: `${seg.kind}-${seg.kind === "pause" ? "" : seg.text}.wav`, frames: sec(1) } };
};
const script = (patch: Partial<Script> = {}): Script => ({
  bookId: "b",
  chapterId: "c",
  episodeNumber: 1,
  coldOpen: [{ kind: "announcer", text: "Good evening." }, { kind: "music", cue: "theme" }],
  scenes: [
    {
      id: "inn",
      ambience: { kind: "sfx", id: "rain" },
      segments: [
        { kind: "narration", text: "The inn." },
        { kind: "dialogue", speaker: "Harker", text: "Hello." },
        { kind: "sfx", sfxId: "door_creak" },
        { kind: "dialogue", speaker: "Landlady", text: "Go." },
      ],
    },
    { id: "road", segments: [{ kind: "pause", ms: 500 }, { kind: "narration", text: "The road." }] },
  ],
  close: [{ kind: "announcer", text: "Tune in next time." }, { kind: "music", cue: "theme" }],
  ...patch,
});
const starts = (t: ReturnType<typeof buildTimeline>) => t.items.map((i) => [i.ref.path, i.startFrame, i.frames]);

describe("buildTimeline", () => {
  it("places every segment with 250 ms between turns and 600 ms between scenes, in samples", () => {
    const t = buildTimeline(script(), audio);
    const a = 0;
    const theme = a + sec(1); // music right after speech: no gap
    const narr = theme + sec(3) + SCENE;
    const harker = narr + sec(1) + TURN;
    const door = harker + sec(1); // sfx after speech: no gap
    const landlady = door + sec(2); // speech after sfx: no gap
    const pause = landlady + sec(1) + SCENE;
    const road = pause + msToFrames(500); // speech after a pause: no gap
    const tune = road + sec(1) + SCENE; // scene to close is a transition, not a turn
    const theme2 = tune + sec(1);
    expect(starts(t)).toEqual([
      ["coldOpen[0]", a, sec(1)],
      ["coldOpen[1]", theme, sec(3)],
      ["scenes[0].segments[0]", narr, sec(1)],
      ["scenes[0].segments[1]", harker, sec(1)],
      ["scenes[0].segments[2]", door, sec(2)],
      ["scenes[0].segments[3]", landlady, sec(1)],
      ["scenes[1].segments[0]", pause, msToFrames(500)],
      ["scenes[1].segments[1]", road, sec(1)],
      ["close[0]", tune, sec(1)],
      ["close[1]", theme2, sec(3)],
    ]);
    expect(t.totalFrames).toBe(theme2 + sec(3));
    expect(t.sampleRate).toBe(24_000);
  });

  it("gives a scene the span of its own items, without the gaps around it, and its ambience", () => {
    const t = buildTimeline(script(), audio);
    expect(t.scenes).toEqual([
      { sceneIdx: 0, id: "inn", title: undefined, startFrame: t.items[2]!.startFrame, endFrame: t.items[5]!.startFrame + sec(1), ambience: { kind: "sfx", id: "rain", gainDb: undefined } },
      { sceneIdx: 1, id: "road", title: undefined, startFrame: t.items[6]!.startFrame, endFrame: t.items[7]!.startFrame + sec(1), ambience: undefined },
    ]);
  });

  it("a scene gap replaces the turn gap even when speech meets speech across scenes", () => {
    const t = buildTimeline(script({ coldOpen: [{ kind: "announcer", text: "Good evening." }] }), audio);
    expect(t.items[1]!.startFrame - (t.items[0]!.startFrame + t.items[0]!.frames)).toBe(SCENE);
  });

  it("trims a cue to its requested length, loops only loopable ones, and never stretches others", () => {
    const one = (seg: Segment) => buildTimeline(script({ scenes: [{ id: "s", segments: [seg] }] }), audio).items.find((i) => i.ref.section === "scenes")!;
    expect(one({ kind: "sfx", sfxId: "door_creak", durationMs: 500 })).toMatchObject({ frames: msToFrames(500), loop: false });
    expect(one({ kind: "sfx", sfxId: "door_creak", durationMs: 9000 })).toMatchObject({ frames: sec(2), loop: false });
    expect(one({ kind: "sfx", sfxId: "rain", durationMs: 25_000 })).toMatchObject({ frames: sec(25), loop: true });
    expect(one({ kind: "sfx", sfxId: "rain", durationMs: 4000 })).toMatchObject({ frames: sec(4), loop: false });
  });

  it("refuses a segment without audio, naming it", () => {
    const missing = (_ref: unknown, seg: Segment): SegmentAudio => (seg.kind === "dialogue" ? {} : audio(_ref, seg));
    expect(() => buildTimeline(script(), missing)).toThrow(new TimelineError("scenes[0].segments[1]", "the line has no rendered audio"));
    expect(() => buildTimeline(script(), (r, s) => (s.kind === "music" ? { asset: { path: "x", frames: 0, loopable: false } } : audio(r, s)))).toThrow(/coldOpen\[1\]: no audio for music cue "theme"/);
  });

  it("lists the ranges where someone speaks", () => {
    const t = buildTimeline(script(), audio);
    const r = speechRanges(t);
    expect(r[0]).toEqual({ start: 0, end: sec(1) });
    expect(r).toHaveLength(t.items.filter((i) => i.kind === "speech").length);
  });

  it("property: items never overlap, are in Script order, and gaps follow the rules exactly", () => {
    const seg = fc.oneof(
      fc.constant<Segment>({ kind: "narration", text: "n" }),
      fc.constant<Segment>({ kind: "dialogue", speaker: "A", text: "d" }),
      fc.constant<Segment>({ kind: "sfx", sfxId: "door_creak" }),
      fc.integer({ min: 1, max: 3000 }).map((ms): Segment => ({ kind: "pause", ms })),
    );
    fc.assert(
      fc.property(fc.array(fc.array(seg, { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 5 }), (scenes) => {
        const s = script({ scenes: scenes.map((segments, i) => ({ id: `s${i}`, segments })) });
        const t = buildTimeline(s, audio);
        const order = segmentsInOrder(s);
        expect(t.items.map((i) => i.ref.path)).toEqual(order.map((o) => o.ref.path));
        for (let i = 1; i < t.items.length; i++) {
          const prev = t.items[i - 1]!;
          const cur = t.items[i]!;
          const gap = cur.startFrame - (prev.startFrame + prev.frames);
          const blockChange = (prev.ref.section === "scenes" ? `s${prev.ref.sceneIdx}` : prev.ref.section) !== (cur.ref.section === "scenes" ? `s${cur.ref.sceneIdx}` : cur.ref.section);
          expect(gap).toBe(blockChange ? SCENE : prev.kind === "speech" && cur.kind === "speech" ? TURN : 0);
        }
        expect(t.totalFrames).toBe(t.items.at(-1)!.startFrame + t.items.at(-1)!.frames);
      }),
      { numRuns: 300 },
    );
  });

  it("converts between milliseconds and samples", () => {
    expect([msToFrames(250), msToFrames(600), framesToMs(24_000)]).toEqual([6000, 14_400, 1000]);
  });
});
