import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CAPTURE_WIDTH, STATIC_FLOOR, crossfadeGains } from "./crossfade";
import { playerKeyAction, type KeyInput } from "./keyboard";
import { StationListSchema, describeTuning, frequencyAt, nearestStation, stationPositions, stepStation, type Station } from "./stations";
import { clock, cueIndexAt, parseVtt, scrollTopToReveal, searchCues } from "./vtt";

const ready = (id: string, n: number): Station => ({ status: "ready", id, book: "Dracula", author: "Bram Stoker", episodeNumber: n, title: `Chapter ${n}`, durationMs: 600_000, cleanUrl: `/episodes/${id}/episode.mp3`, amUrl: `/episodes/${id}/episode-am.mp3`, vttUrl: `/episodes/${id}/episode.vtt` });

describe("stations", () => {
  it("validates the station list: same-site files only, no duplicate ids", () => {
    expect(StationListSchema.safeParse({ stations: [ready("d1", 1), { status: "warming", id: "d2", book: "Dracula", author: "Bram Stoker", episodeNumber: 2, title: "II", rendered: 40, total: 120 }] }).success).toBe(true);
    for (const bad of [{ ...ready("d1", 1), cleanUrl: "https://evil.example/x.mp3" }, { ...ready("d1", 1), cleanUrl: "//evil.example/x.mp3" }, { ...ready("d1", 1), vttUrl: "javascript:alert(1)" }, { ...ready("d1", 1), amUrl: "/episodes/../../etc/x.mp3" }, { ...ready("d1", 1), amUrl: "/episodes//x.mp3" }, { ...ready("d1", 1), extra: 1 }]) {
      expect(StationListSchema.safeParse({ stations: [bad] }).success).toBe(false);
    }
    expect(StationListSchema.safeParse({ stations: [ready("d1", 1), ready("d1", 2)] }).success).toBe(false);
  });

  it("spaces stations evenly with room to tune past both ends", () => {
    expect(stationPositions(0)).toEqual([]);
    expect(stationPositions(1)).toEqual([0.5]);
    expect(stationPositions(3)).toEqual([0.1, 0.5, 0.9]);
  });

  it("finds the nearest station and steps between them", () => {
    const p = stationPositions(3);
    expect(nearestStation(p, 0.52)).toEqual({ index: 1, distance: expect.closeTo(0.02, 10) });
    expect(nearestStation([], 0.5)).toEqual({ index: -1, distance: Infinity });
    expect([stepStation(p, 0.5, 1), stepStation(p, 0.5, -1), stepStation(p, 0.95, 1), stepStation(p, 0.02, -1), stepStation(p, 0.3, 1)]).toEqual([0.9, 0.1, 0.9, 0.1, 0.5]);
  });

  it("shows AM-band frequencies on 10 kHz channels", () => {
    expect([frequencyAt(0), frequencyAt(1), frequencyAt(0.5), frequencyAt(-3), frequencyAt(Number.NaN)]).toEqual([540, 1600, 1070, 540, 540]);
  });

  it("describes the tuning for screen readers", () => {
    const stations = [ready("d1", 1), { status: "warming" as const, id: "d2", book: "Dracula", author: "Bram Stoker", episodeNumber: 2, title: "II", rendered: 40, total: 120 }];
    const p = stationPositions(2);
    expect(describeTuning(stations, p, 0.1, CAPTURE_WIDTH)).toBe("650 kilocycles, Dracula, episode 1: Chapter 1");
    expect(describeTuning(stations, p, 0.9, CAPTURE_WIDTH)).toBe("1490 kilocycles, Dracula, episode 2: II, warming up, 40 of 120 lines rendered");
    expect(describeTuning(stations, p, 0.5, CAPTURE_WIDTH)).toBe("1070 kilocycles, static");
  });
});

describe("crossfadeGains", () => {
  it("is all broadcast on the station (with a trace of static) and all static beyond the capture width", () => {
    expect(crossfadeGains(0)).toEqual({ broadcast: 1, static: STATIC_FLOOR });
    expect(crossfadeGains(CAPTURE_WIDTH)).toEqual({ broadcast: 0, static: 1 });
    expect(crossfadeGains(1)).toEqual({ broadcast: 0, static: 1 });
    expect(crossfadeGains(Infinity)).toMatchObject({ static: 1 });
  });

  it("property: equal power (without the floor) and monotonic in distance", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.2, noNaN: true }), fc.double({ min: 0, max: 0.2, noNaN: true }), (a, b) => {
        const g = crossfadeGains(a, CAPTURE_WIDTH, 0);
        expect(g.broadcast ** 2 + g.static ** 2).toBeCloseTo(1, 9);
        const [near, far] = a <= b ? [crossfadeGains(a), crossfadeGains(b)] : [crossfadeGains(b), crossfadeGains(a)];
        expect(near.broadcast).toBeGreaterThanOrEqual(far.broadcast);
        expect(near.static).toBeLessThanOrEqual(far.static);
      }),
      { numRuns: 300 },
    );
  });
});

describe("parseVtt", () => {
  const vtt = "WEBVTT\r\n\r\nNOTE made by the mixer\r\n\r\n1\r\n00:00:00.000 --> 00:00:01.500\r\n<v Announcer>Good evening.\r\n\r\n2\r\n00:00:02.100 --> 00:00:04.000 align:start\r\n<v Count Dracula>Welcome &amp; enter &lt;freely&gt;.\r\n\r\n00:01:02.000 --> 00:01:03.000\r\nNo voice tag.\r\n";
  it("reads cues with speakers, unescapes text, and skips notes", () => {
    expect(parseVtt(vtt)).toEqual([
      { startMs: 0, endMs: 1500, speaker: "Announcer", text: "Good evening." },
      { startMs: 2100, endMs: 4000, speaker: "Count Dracula", text: "Welcome & enter <freely>." },
      { startMs: 62_000, endMs: 63_000, speaker: null, text: "No voice tag." },
    ]);
    expect(parseVtt("WEBVTT\n\n01:02:03.004 --> 01:02:04.000\n<v.loud Igor>Yes!")).toEqual([{ startMs: 3_723_004, endMs: 3_724_000, speaker: "Igor", text: "Yes!" }]);
  });

  it("refuses a file that is not WebVTT and skips broken cues", () => {
    expect(() => parseVtt("<html>")).toThrow(/not a WebVTT/);
    expect(parseVtt("WEBVTT\n\n00:00:05.000 --> 00:00:01.000\nbackwards\n\nnot a time --> x\ntext")).toEqual([]);
  });

  it("finds the cue playing at a time, and none between cues", () => {
    const cues = parseVtt(vtt);
    expect([cueIndexAt(cues, 0), cueIndexAt(cues, 1499), cueIndexAt(cues, 1500), cueIndexAt(cues, 2100), cueIndexAt(cues, 62_500), cueIndexAt(cues, 99_999), cueIndexAt([], 5)]).toEqual([0, 0, -1, 1, 2, -1, -1]);
  });

  it("property: cueIndexAt agrees with a linear scan", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(10_000), fc.integer({ min: 1, max: 3_000 })), { maxLength: 30 }), fc.nat(15_000), (spans, t) => {
        // non-overlapping cues, as the mixer writes them
        let at = 0;
        const cues = spans.map(([gap, len]) => {
          const c = { startMs: at + gap, endMs: at + gap + len, speaker: null, text: "" };
          at = c.endMs;
          return c;
        });
        const linear = cues.findIndex((c) => c.startMs <= t && t < c.endMs);
        expect(cueIndexAt(cues, t)).toBe(linear);
      }),
      { numRuns: 300 },
    );
  });

  it("searches text and speakers, and formats times", () => {
    const cues = parseVtt(vtt);
    expect([searchCues(cues, "WELCOME"), searchCues(cues, "dracula"), searchCues(cues, "  "), searchCues(cues, "zzz")]).toEqual([[1], [1], [], []]);
    expect([clock(0), clock(61_999), clock(3_723_000)]).toEqual(["0:00", "1:01", "1:02:03"]);
  });
});

describe("playerKeyAction", () => {
  const key = (k: string, target: Partial<KeyInput["target"]> = {}, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, ...mods, target: { tagName: "DIV", inPlayer: true, ...target } });
  it("maps Space and the arrow keys inside the player", () => {
    expect([playerKeyAction(key(" ")), playerKeyAction(key("ArrowLeft")), playerKeyAction(key("ArrowDown")), playerKeyAction(key("ArrowRight")), playerKeyAction(key("ArrowUp")), playerKeyAction(key("a"))]).toEqual(["toggle", "previous", "previous", "next", "next", null]);
  });

  it("never acts while typing, outside the player, with a modifier, or twice for a button", () => {
    expect(playerKeyAction(key(" ", { tagName: "input" }))).toBeNull();
    expect(playerKeyAction(key("ArrowLeft", { tagName: "TEXTAREA" }))).toBeNull();
    expect(playerKeyAction(key(" ", { isContentEditable: true }))).toBeNull();
    expect(playerKeyAction(key(" ", { inPlayer: false }))).toBeNull();
    expect(playerKeyAction(key("ArrowRight", {}, { ctrlKey: true }))).toBeNull();
    expect(playerKeyAction(key(" ", { tagName: "BUTTON" }))).toBeNull();
    expect(playerKeyAction(key("ArrowRight", { tagName: "BUTTON" }))).toBe("next");
  });
});
describe("following the transcript", () => {
  const view = { scrollTop: 100, height: 300 };
  it("scrolls the list only as far as needed to show the line playing", () => {
    expect(scrollTopToReveal(view, { top: 150, height: 40 })).toBe(100); // already in view
    expect(scrollTopToReveal(view, { top: 60, height: 40 })).toBe(60); // above: show its top
    expect(scrollTopToReveal(view, { top: 390, height: 40 })).toBe(130); // below: show its bottom
    expect(scrollTopToReveal(view, { top: 500, height: 400 })).toBe(500); // taller than the list: its top
  });
});
