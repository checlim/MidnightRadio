import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "@midnight-radio/tts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestExcerpt, chooseMusic, judgeExcerpt, musicIdFor, MusicSourcesSchema, pickMusic, windowLevels, type AnalysedSource, type MusicSource } from "./music-pick.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** Window levels (dB) built from runs: [[level, seconds], ...]. */
const lv = (...runs: [number, number][]) => runs.flatMap(([d, s]) => Array<number>(Math.round(s * 10)).fill(d));

const src = (file: string, cues: MusicSource["cues"]): MusicSource => ({ file, title: file, sourcePage: `https://example.org/${file}`, author: "A", licence: "CC0-1.0", sha256: "0".repeat(64), cues });

describe("judging excerpts", () => {
  it("rejects a gap or a cut before the fade-out, and allows either inside it", () => {
    // Transition: 5 s with a 1 s fade-out, so the last 10 windows are not checked.
    expect(judgeExcerpt(lv([-10, 2], [-60, 0.5], [-10, 2.5]), 0, 50, "transition").rejected).toBe("gap at 2 s");
    expect(judgeExcerpt(lv([-10, 4.2], [-60, 0.8]), 0, 50, "transition").rejected).toBeNull(); // reverb tail in the fade
    expect(judgeExcerpt(lv([-10, 2], [-35, 3]), 0, 50, "transition").rejected).toBe("cut at 2 s");
    expect(judgeExcerpt(lv([-10, 4.5], [-35, 0.5]), 0, 50, "transition").rejected).toBeNull(); // dry stop in the fade
    // A gap is relative to the file's loudest window, not only the −50 dBFS floor.
    expect(judgeExcerpt([...lv([0, 1]), ...lv([-20, 1], [-32, 0.2], [-20, 4])], 10, 50, "transition").rejected).toBe("gap at 2 s");
  });

  it("prefers loud, steady excerpts that start at once; a sting must hit in its first 200 ms", () => {
    const steady = judgeExcerpt(lv([-10, 5]), 0, 50, "transition").score!;
    expect(judgeExcerpt(lv([-16, 5], [-10, 1]), 0, 50, "transition").score!).toBeLessThan(steady); // quieter than the file's best
    expect(judgeExcerpt(lv([-14, 0.5], [-8, 0.5], [-14, 0.5], [-8, 0.5], [-14, 0.5], [-8, 0.5], [-14, 0.5], [-8, 0.5], [-11, 1]), 0, 50, "transition").score!).toBeLessThan(steady);
    expect(judgeExcerpt(lv([-20, 0.3], [-10, 4.7]), 0, 50, "transition").score!).toBeLessThan(steady); // slow start
    const hit = judgeExcerpt(lv([-6, 2]), 0, 20, "sting").score!;
    const late = judgeExcerpt(lv([-14, 0.3], [-6, 1.7]), 0, 20, "sting").score!;
    expect(hit - late).toBeGreaterThan(20);
  });

  it("finds the best start, keeps the earliest on a tie, uses a short file whole, and refuses one that is too short", () => {
    expect(bestExcerpt(lv([-30, 3], [-8, 6], [-30, 3]), "transition")).toMatchObject({ startS: 3, durationS: 5 });
    expect(bestExcerpt(lv([-8, 9]), "transition")).toMatchObject({ startS: 0 });
    expect(bestExcerpt(lv([-6, 1.5]), "sting")).toMatchObject({ startS: 0, durationS: 1.5, rejected: null });
    expect(bestExcerpt(lv([-6, 1]), "sting")).toEqual({ rejected: "1 s long, shorter than 1.2 s", score: null });
    expect(bestExcerpt(lv([-8, 8], [-70, 1], [-8, 8]), "theme").rejected).toMatch(/^every excerpt has a gap or a cut/);
  });
});

describe("chooseMusic", () => {
  const ok = (source: MusicSource, levels: number[]): AnalysedSource => ({ source, levels, problem: null });

  it("uses only the files allowed for each cue, records why others lost, and ties to the earlier file", () => {
    const { choices, report } = chooseMusic([
      ok(src("organ.wav", ["theme", "transition"]), lv([-6, 30])),
      ok(src("overture.mp3", ["theme"]), lv([-6, 30])),
      { source: src("changed.wav", ["sting"]), levels: null, problem: "sha256 mismatch" },
      ok(src("riff.wav", ["sting"]), lv([-6, 1.5])),
      ok(src("big.wav", ["sting"]), lv([-6, 0.2], [-60, 2])),
    ]);
    expect(choices.map((c) => [c.cue, c.source.file, c.id, c.startS, c.durationS, c.fadeOutS])).toEqual([
      ["theme", "organ.wav", "theme_organ", 0, 20, 2],
      ["sting", "riff.wav", "sting_riff", 0, 1.5, 0.5],
      ["transition", "organ.wav", "transition_organ", 0, 5, 1],
    ]);
    const sting = report.cues.find((c) => c.cue === "sting")!;
    expect(sting.candidates.map((c) => [c.file, c.rejected === null])).toEqual([["changed.wav", false], ["riff.wav", true], ["big.wav", false]]);
    expect(sting.candidates[0]!.rejected).toBe("sha256 mismatch");
  });

  it("leaves a cue unpicked when no allowed file fits", () => {
    const { choices, report } = chooseMusic([ok(src("riff.wav", ["sting"]), lv([-6, 1.5]))]);
    expect(choices.map((c) => c.cue)).toEqual(["sting"]);
    expect(report.cues.find((c) => c.cue === "theme")).toEqual({ cue: "theme", picked: null, candidates: [] });
  });

  it("makes library ids from file names", () => {
    expect(musicIdFor("theme", "lisboa-horror-overture.mp3")).toBe("theme_lisboa_horror_overture");
    expect(musicIdFor("sting", "Organ Riff (Dead).WAV")).toBe("sting_organ_riff_dead");
    expect(musicIdFor("transition", `${"x".repeat(60)}.wav`)).toHaveLength(48);
  });

  it("accepts only CC0 sources with https pages and known cues", () => {
    const base = { version: 1, items: [{ ...src("a.wav", ["theme"]) }] };
    expect(MusicSourcesSchema.safeParse(base).success).toBe(true);
    expect(MusicSourcesSchema.safeParse({ ...base, items: [{ ...base.items[0], licence: "CC-BY-4.0" }] }).success).toBe(false);
    expect(MusicSourcesSchema.safeParse({ ...base, items: [{ ...base.items[0], sourcePage: "http://example.org/a" }] }).success).toBe(false);
    expect(MusicSourcesSchema.safeParse({ ...base, items: [{ ...base.items[0], cues: ["intro"] }] }).success).toBe(false);
    expect(MusicSourcesSchema.safeParse({ ...base, items: [{ ...base.items[0], file: "../a.wav" }] }).success).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("pickMusic (real ffmpeg)", () => {
  let dir: string;
  const RATE = 44_100;
  const tone = (seconds: number, amp: (t: number) => number) => Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.round(amp(i / RATE) * 32767 * Math.sin((2 * Math.PI * 220 * i) / RATE)));
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-music-"));
    const files = {
      // Quiet for 10 s, then loud for 25 s: the theme should start at 10 s.
      "overture.wav": encodeWav(tone(35, (t) => (t < 10 ? 0.05 : 0.5)), RATE),
      "riff.wav": encodeWav(tone(1.5, () => 0.5), RATE),
      "fugue.wav": encodeWav(tone(8, () => 0.4), RATE),
    };
    const items = [];
    for (const [file, bytes] of Object.entries(files)) {
      await writeFile(join(dir, file), bytes);
      items.push({ ...src(file, file === "overture.wav" ? ["theme"] : file === "riff.wav" ? ["sting"] : ["transition"]), sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    items.push({ ...src("changed.wav", ["sting"]), sha256: "1".repeat(64) });
    items.push({ ...src("absent.wav", ["sting"]) });
    await writeFile(join(dir, "changed.wav"), encodeWav(tone(1.5, () => 0.9), RATE));
    await writeFile(join(dir, "sources.json"), JSON.stringify({ version: 1, items }));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("decodes each file, refuses changed or missing ones, and picks the loud part", async () => {
    const { choices, report } = await pickMusic(join(dir, "sources.json"), dir);
    expect(choices.map((c) => [c.cue, c.source.file, c.startS, c.durationS])).toEqual([
      ["theme", "overture.wav", 10, 20],
      ["sting", "riff.wav", 0, 1.5],
      ["transition", "fugue.wav", 0, 5],
    ]);
    const sting = report.cues.find((c) => c.cue === "sting")!.candidates;
    expect(sting.find((c) => c.file === "changed.wav")!.rejected).toMatch(/sha256 mismatch/);
    expect(sting.find((c) => c.file === "absent.wav")!.rejected).toMatch(/^missing from/);
    expect(await pickMusic(join(dir, "sources.json"), dir)).toEqual({ choices, report });
  });

  it("measures 100 ms windows", () => {
    expect(windowLevels(tone(1, () => 0.5), RATE)).toHaveLength(10);
    expect(windowLevels(new Int16Array(4410), RATE)).toEqual([-120]);
  });
});
