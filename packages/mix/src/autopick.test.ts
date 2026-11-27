import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "@midnight-radio/tts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autopick, chooseTake, judgeTake, measureTake, readPcm16, type TakeVerdict } from "./autopick.js";

const RATE = 48_000;
let seed = 7;
const noise = () => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const make = (seconds: number, f: (t: number) => number) => Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.max(-32768, Math.min(32767, Math.round(f(i / RATE) * 32767))));

/** A creak: a decaying tone that starts at once. */
const creak = (seconds: number, amp = 0.3, delay = 0) => make(seconds, (t) => (t < delay ? 0 : amp * Math.sin(2 * Math.PI * 300 * t) * Math.exp(-(t - delay) * 0.6)));
/** Rain: steady noise. */
const rain = (seconds: number, amp = 0.15) => make(seconds, () => amp * noise());

describe("measureTake and judgeTake", () => {
  const discrete = { durationSec: 3, loopable: false };
  const bed = { durationSec: 6, loopable: true };
  const judge = (s: Int16Array, cue: { durationSec: number; loopable: boolean }) => judgeTake(measureTake(1, s, RATE), cue);

  it("accepts a clean one-off sound and a clean bed", () => {
    expect(judge(creak(3), discrete)).toMatchObject({ rejected: null, durationS: 3, clicks: 0, leadSilenceS: 0 });
    expect(judge(rain(6), bed)).toMatchObject({ rejected: null, longestDropoutS: 0 });
  });

  it("rejects the wrong length, clipping, near silence, a sound that is mostly silence, and a bed that drops out", () => {
    expect(judge(creak(3.5), discrete).rejected).toBe("3.5 s long, not 3 s");
    expect(judge(make(3, (t) => 1.4 * Math.sin(2 * Math.PI * 200 * t)), discrete).rejected).toMatch(/^clips/);
    expect(judge(make(3, () => 0.001 * noise()), discrete).rejected).toMatch(/^nearly silent/);
    // Mostly silence and not a clear transient: too quiet, too late, or too brief.
    expect(judge(make(3, (t) => (t < 0.3 ? 0.05 * Math.sin(2 * Math.PI * 300 * t) : 0)), discrete).rejected).toMatch(/audible for only 10 %/);
    expect(judge(make(3, (t) => (t > 1 && t < 1.3 ? 0.4 * Math.sin(2 * Math.PI * 300 * t) : 0)), discrete).rejected).toMatch(/audible for only 10 %/);
    expect(judge(make(6, (t) => (t > 2 && t < 3.5 ? 0 : 0.15 * noise())), bed).rejected).toMatch(/drops out for 1\.5 s/);
  });

  it("accepts a short match strike that fills only 7 % of a 3 s file, without loosening the other checks", () => {
    // A 210 ms strike: a sharp noisy flare that decays, then silence.
    const strike = make(3, (t) => (t < 0.21 ? 0.6 * Math.exp(-t * 12) * noise() : 0));
    const v = judge(strike, discrete);
    expect(v.activeFraction).toBeLessThan(0.15);
    expect(v.longestActiveS).toBeGreaterThanOrEqual(0.1);
    expect(v).toMatchObject({ rejected: null, leadSilenceS: 0 });
    // The same strike clipped, or in a file of the wrong length, is still out.
    expect(judge(make(3, (t) => (t < 0.21 ? 1.5 * noise() : 0)), discrete).rejected).toMatch(/^clips/);
    expect(judge(make(3.5, (t) => (t < 0.21 ? 0.6 * Math.exp(-t * 12) * noise() : 0)), discrete).rejected).toMatch(/not 3 s/);
    // A 30 ms blip is not a transient.
    expect(judge(make(3, (t) => (t < 0.03 ? 0.6 * noise() : 0)), discrete).rejected).toMatch(/nearly silent|audible for only/);
  });

  it("scores clicks, a late start and an unsteady bed lower", () => {
    const clicky = creak(3);
    for (const at of [0.5, 1.2, 2.1]) {
      clicky[Math.round(at * RATE)] = 32_000;
      clicky[Math.round(at * RATE) + 1] = -32_000;
    }
    const clean = judge(creak(3), discrete);
    expect(judge(clicky, discrete).clicks).toBe(3);
    expect(judge(clicky, discrete).score!).toBeLessThan(clean.score!);
    expect(judge(creak(3, 0.3, 1), discrete).score!).toBeLessThan(clean.score!);
    const surging = make(6, (t) => (0.04 + 0.16 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.4 * t))) * noise());
    expect(judge(surging, bed).levelSpreadDb).toBeGreaterThan(judge(rain(6), bed).levelSpreadDb);
    expect(judge(surging, bed).score!).toBeLessThan(judge(rain(6), bed).score!);
  });

  it("chooses the best score, the lowest take on a tie, and nothing if all are rejected", () => {
    const v = (take: number, score: number | null): TakeVerdict => ({ take, score, rejected: score === null ? "x" : null }) as TakeVerdict;
    expect(chooseTake([v(1, 80), v(2, 95), v(3, 95)])).toBe(2);
    expect(chooseTake([v(1, null), v(2, null)])).toBeNull();
    expect(chooseTake([])).toBeNull();
  });

  it("reads WAVs at any rate", () => {
    const { samples, rate } = readPcm16(new Uint8Array(encodeWav(creak(1), RATE)));
    expect([rate, samples.length]).toEqual([RATE, RATE]);
    expect(() => readPcm16(new Uint8Array(10))).toThrow();
  });
});

describe("autopick", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-autopick-"));
    const sfx = join(dir, "sfx");
    const cand = join(dir, "cand");
    await mkdir(sfx, { recursive: true });
    const cues = [
      { id: "door_creak", prompt: "A door creaks.", durationSec: 3, seed: 10, loopable: false },
      { id: "rain", prompt: "Steady rain.", durationSec: 6, seed: 20, loopable: true },
      { id: "thunder", prompt: "Thunder.", durationSec: 3, seed: 30, loopable: false },
    ];
    await writeFile(join(sfx, "prompts.json"), JSON.stringify({ version: 1, cues }));
    const files: Record<string, Int16Array[]> = {
      door_creak: [creak(3, 0.3, 1.5), creak(3), creak(3.4)], // late start, good, wrong length
      rain: [make(6, (t) => (t > 2 && t < 3.5 ? 0 : 0.15 * noise())), rain(6)], // drop-out, good
      thunder: [make(3, () => 0.0005 * noise())], // silent only
    };
    const takes: Record<string, Record<string, unknown>> = {};
    for (const cue of cues) {
      await mkdir(join(cand, cue.id), { recursive: true });
      takes[cue.id] = {};
      for (const [i, s] of files[cue.id]!.entries()) {
        await writeFile(join(cand, cue.id, `take-${i + 1}.wav`), encodeWav(s, RATE));
        takes[cue.id]![String(i + 1)] = { prompt: cue.prompt, durationSec: cue.durationSec, seed: cue.seed + i, file: `take-${i + 1}.wav`, sha256: "x" };
      }
    }
    // A take from an older prompt is ignored even if it would score well.
    await writeFile(join(cand, "rain", "take-3.wav"), encodeWav(rain(6), RATE));
    takes.rain!["3"] = { prompt: "Old rain prompt.", durationSec: 6, seed: 22, file: "take-3.wav", sha256: "x" };
    await writeFile(join(cand, "takes.json"), JSON.stringify({ model: { model: "stub-sfx", revision: "r1", license: "CC0-1.0" }, takes }));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("picks the best usable take per cue, records why, and leaves a cue with no usable take unpicked", async () => {
    const { picks, report } = await autopick(join(dir, "sfx"), join(dir, "cand"));
    expect(picks).toEqual({ door_creak: 2, rain: 2, thunder: null });
    const byId = Object.fromEntries(report.cues.map((c) => [c.id, c]));
    expect(byId.door_creak!.takes.map((t) => t.rejected)).toEqual([null, null, "3.4 s long, not 3 s"]);
    expect(byId.rain!.takes.map((t) => t.take)).toEqual([1, 2]); // take 3 belongs to an older prompt
    expect(byId.rain!.takes[0]!.rejected).toMatch(/drops out/);
    expect(byId.thunder!.reason).toBe("every take was rejected");
    expect(report).toMatchObject({ version: "autopick-1", model: { model: "stub-sfx", revision: "r1" } });
  });

  it("is repeatable", async () => {
    const a = await autopick(join(dir, "sfx"), join(dir, "cand"));
    const b = await autopick(join(dir, "sfx"), join(dir, "cand"));
    expect(b).toEqual(a);
  });
});
