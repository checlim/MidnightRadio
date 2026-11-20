import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Script, Segment } from "@midnight-radio/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DUCKING_DEFAULTS, dbToGain, duckingEnvelope, encodeFloatWav, gainToDb } from "./envelope.js";
import { mixGraph, renderMix } from "./render.js";
import { SAMPLE_RATE, buildTimeline, msToFrames, speechRanges, type SegmentAudio, type Timeline } from "./timeline.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");

describe("duckingEnvelope", () => {
  const rate = SAMPLE_RATE;
  it("is full level between lines and duckDb below it during speech, after the attack", () => {
    const env = duckingEnvelope(0, rate * 10, [{ start: rate * 3, end: rate * 5 }], { fadeMs: 0 });
    expect(env[rate * 2]).toBe(1);
    const attack = msToFrames(DUCKING_DEFAULTS.attackMs);
    expect(gainToDb(env[rate * 3 + attack]!)).toBeCloseTo(-18, 5);
    expect(gainToDb(env[rate * 4]!)).toBeCloseTo(-18, 5);
    expect(env[rate * 3]!).toBeLessThan(1); // the attack starts at the line's first sample
    expect(env[rate * 5 + msToFrames(DUCKING_DEFAULTS.releaseMs) + 1]).toBe(1);
  });

  it("holds the duck across a short silence between lines instead of pumping", () => {
    const env = duckingEnvelope(0, rate * 10, [{ start: rate * 1, end: rate * 2 }, { start: rate * 2 + msToFrames(250), end: rate * 3 }], { fadeMs: 0 });
    expect(gainToDb(env[rate * 2 + msToFrames(100)]!)).toBeCloseTo(-18, 5);
  });

  it("fades in and out at the scene's edges, and only counts speech inside the scene", () => {
    const env = duckingEnvelope(rate * 10, rate * 20, [{ start: 0, end: rate * 5 }, { start: rate * 30, end: rate * 31 }]);
    expect(env.length).toBe(rate * 10);
    expect(env[0]!).toBeLessThan(0.01);
    expect(env[env.length - 1]!).toBeLessThan(0.01);
    expect(env[rate * 5]).toBe(1);
  });

  it("writes a valid float WAV", () => {
    const wav = encodeFloatWav(new Float32Array([0, 0.5, -1]));
    expect(wav.length).toBe(44 + 12);
    expect([wav.toString("ascii", 0, 4), wav.readUInt16LE(20), wav.readUInt16LE(34), wav.readFloatLE(48)]).toEqual(["RIFF", 3, 32, 0.5]);
  });
});

/** Read a float WAV written by renderMix. */
async function readFloat(path: string): Promise<Float32Array> {
  const b = await readFile(path);
  let pos = 12;
  while (pos + 8 <= b.length) {
    const tag = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (tag === "data") {
      const out = new Float32Array(size / 4);
      for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(pos + 8 + i * 4);
      return out;
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}
const rms = (s: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += s[i]! * s[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
};
/** First sample at or after `from` whose magnitude exceeds `threshold`. */
const onset = (s: Float32Array, from: number, threshold = 0.01) => {
  for (let i = from; i < s.length; i++) if (Math.abs(s[i]!) > threshold) return i;
  return -1;
};

describe.skipIf(!hasFfmpeg)("renderMix (real ffmpeg)", () => {
  let dir: string;
  let timeline: Timeline;
  const tone = (seconds: number, freq: number, amp = 0.5, rate = SAMPLE_RATE) => encodeFloatWav(Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate)), rate);
  const script: Script = {
    bookId: "b",
    chapterId: "c",
    episodeNumber: 1,
    coldOpen: [{ kind: "announcer", text: "Good evening." }],
    scenes: [
      { id: "inn", ambience: { kind: "sfx", id: "rain" }, segments: [{ kind: "narration", text: "The inn." }, { kind: "dialogue", speaker: "A", text: "Hi." }, { kind: "pause", ms: 2000 }, { kind: "sfx", sfxId: "knock" }] },
      { id: "road", segments: [{ kind: "dialogue", speaker: "B", text: "Bye." }] },
    ],
    close: [{ kind: "announcer", text: "Tune in next time." }, { kind: "music", cue: "theme" }],
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-mix-"));
    await writeFile(join(dir, "speech.wav"), tone(1, 440));
    // A 48 kHz knock checks conversion; the theme is shorter than its cue would like, so it is not stretched.
    await writeFile(join(dir, "knock.wav"), tone(0.5, 880, 0.5, 48_000));
    await writeFile(join(dir, "theme.wav"), tone(2, 330));
    // The bed is a 1.5 s file, so it must loop to fill the scene.
    await writeFile(join(dir, "rain.wav"), encodeFloatWav(Float32Array.from({ length: SAMPLE_RATE * 1.5 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE))));
    const audio = (_r: unknown, seg: Segment): SegmentAudio =>
      seg.kind === "sfx" ? { asset: { path: join(dir, "knock.wav"), frames: SAMPLE_RATE / 2, loopable: false } } : seg.kind === "music" ? { asset: { path: join(dir, "theme.wav"), frames: SAMPLE_RATE * 2, loopable: false } } : { speech: { path: join(dir, "speech.wav"), frames: SAMPLE_RATE } };
    timeline = buildTimeline(script, audio);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const opts = (stem?: "full" | "beds" | "dry") => ({ beds: () => ({ path: join(dir, "rain.wav"), frames: SAMPLE_RATE * 1.5 }), workDir: dir, ...(stem ? { stem } : {}), log: () => {} });

  it("puts every item at its exact sample, with silence in the gaps, and the exact total length", async () => {
    const out = join(dir, "dry.wav");
    await renderMix(timeline, out, opts("dry"));
    const s = await readFloat(out);
    expect(s.length).toBe(timeline.totalFrames);
    for (const [k, it] of timeline.items.entries()) {
      const prev = timeline.items[k - 1];
      const gapBefore = prev ? it.startFrame - (prev.startFrame + prev.frames) : 0;
      if (it.kind === "pause") {
        expect(rms(s, it.startFrame, it.startFrame + it.frames)).toBe(0);
        continue;
      }
      // a sine starting at phase 0 crosses the threshold within a few samples of its start
      expect(onset(s, it.startFrame) - it.startFrame).toBeLessThan(10);
      if (gapBefore >= 100 || (prev?.kind === "pause" && prev.frames >= 100)) expect(rms(s, it.startFrame - 100, it.startFrame)).toBe(0);
    }
    expect(rms(s, timeline.items[0]!.frames, timeline.items[1]!.startFrame)).toBe(0); // the 600 ms gap
  });

  it("loops the bed over its scene only, ducks it ≥12 dB under speech after the attack, and fades it", async () => {
    const out = join(dir, "beds.wav");
    await renderMix(timeline, out, opts("beds"));
    const s = await readFloat(out);
    const scene = timeline.scenes[0]!;
    expect(rms(s, 0, scene.startFrame)).toBe(0);
    expect(rms(s, scene.endFrame, s.length)).toBe(0);
    const attack = msToFrames(DUCKING_DEFAULTS.attackMs);
    const speech = speechRanges(timeline).filter((r) => r.start >= scene.startFrame && r.end <= scene.endFrame);
    const pause = timeline.items.find((i) => i.kind === "pause")!;
    // full-level reference: the middle of the 2 s pause, well after the release
    const open = rms(s, pause.startFrame + msToFrames(800), pause.startFrame + msToFrames(1600));
    expect(open).toBeGreaterThan(0.05);
    for (const r of speech) {
      const ducked = rms(s, r.start + attack, r.end);
      expect(gainToDb(open / ducked)).toBeGreaterThanOrEqual(12);
    }
    // bed level between lines matches the default bed gain (-14 dB of a 0.5 sine, RMS 0.354)
    expect(gainToDb(open / (0.5 / Math.SQRT2))).toBeCloseTo(-14, 0);
  });

  it("mixes speech and beds into one file", async () => {
    const out = join(dir, "full.wav");
    await renderMix(timeline, out, opts());
    const [full, dry, beds] = await Promise.all([readFloat(out), readFloat(join(dir, "dry.wav")), readFloat(join(dir, "beds.wav"))]);
    expect(full.length).toBe(timeline.totalFrames);
    let maxDiff = 0;
    for (let i = 0; i < full.length; i++) maxDiff = Math.max(maxDiff, Math.abs(full[i]! - (dry[i]! + beds[i]!)));
    expect(maxDiff).toBeLessThan(1e-5);
  });

  it("removes its envelope files and logs the graph on failure", async () => {
    expect((await readdir(dir)).filter((f) => f.startsWith("env-"))).toEqual([]);
    const logs: string[] = [];
    await expect(renderMix(timeline, join(dir, "x.wav"), { ...opts(), beds: () => ({ path: join(dir, "missing.wav"), frames: 10 }), log: (m: string) => logs.push(m) })).rejects.toThrow();
    expect(logs[0]).toContain("filter graph: ");
    expect((await readdir(dir)).filter((f) => f.startsWith("env-"))).toEqual([]);
  });

  it("cuts a cue to its requested length, so nothing spills into the next item", async () => {
    const cut: Script = { ...script, scenes: [{ id: "s", segments: [{ kind: "sfx", sfxId: "knock", durationMs: 200 }, { kind: "pause", ms: 1000 }] }] };
    const audio = (_r: unknown, seg: Segment): SegmentAudio =>
      seg.kind === "sfx" ? { asset: { path: join(dir, "knock.wav"), frames: SAMPLE_RATE / 2, loopable: false } } : seg.kind === "music" ? { asset: { path: join(dir, "theme.wav"), frames: SAMPLE_RATE * 2, loopable: false } } : { speech: { path: join(dir, "speech.wav"), frames: SAMPLE_RATE } };
    const t = buildTimeline(cut, audio);
    const knock = t.items.find((i) => i.kind === "sfx")!;
    expect(knock.frames).toBe(msToFrames(200));
    const out = join(dir, "cut.wav");
    await renderMix(t, out, opts("dry"));
    const s = await readFloat(out);
    expect(rms(s, knock.startFrame, knock.startFrame + knock.frames)).toBeGreaterThan(0.1);
    expect(rms(s, knock.startFrame + knock.frames, knock.startFrame + knock.frames + msToFrames(900))).toBe(0);
  });

  it("uses each file once as an input however often it is placed", () => {
    const { inputs } = mixGraph(timeline, opts(), () => "env.wav");
    expect(inputs.map((i) => ("path" in i ? i.path.split("/").pop() : ""))).toEqual(["speech.wav", "knock.wav", "theme.wav", "rain.wav", "env.wav"]);
  });

  it("checks the bed gain constant", () => {
    expect(dbToGain(-14)).toBeCloseTo(0.2, 1);
  });
});
