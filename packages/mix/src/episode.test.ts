import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Script, SfxCatalogue, SfxEntry } from "@midnight-radio/core";
import { RenderCache, StubProvider, encodeWav, renderSegments } from "@midnight-radio/tts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gainToDb } from "./envelope.js";
import { mixEpisode, type EpisodeOutput } from "./episode.js";
import { probeAudio, runFfmpeg } from "./ffmpeg.js";
import { LUFS_TOLERANCE, MAX_TRUE_PEAK, TARGET_LUFS, measureLoudness } from "./master.js";
import { renderMix } from "./render.js";
import { SAMPLE_RATE, framesToMs, msToFrames, segmentsInOrder, speechRanges, type AudioFile } from "./timeline.js";

/**
 * Task 9.5 (Req 6.1–6.5): a whole episode from the offline StubProvider, through the real render
 * cache, the sound library and the mixer, to both MP3 variants. Measured after decoding: loudness
 * and true peak of each variant, equal lengths, the bed's real attenuation under speech, and
 * that the transcript and chapter markers line up with the decoded audio (encoder delay included).
 */
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");

const VOICES: Record<string, string> = { Announcer: "stub-announcer", Narrator: "stub-narrator", "Jonathan Harker": "stub-m1", "Count Dracula": "stub-m2", "The landlady": "stub-f2" };
const SCRIPT: Script = {
  bookId: "dracula",
  chapterId: "c1",
  episodeNumber: 1,
  coldOpen: [
    { kind: "announcer", text: "Good evening, listeners. This is Midnight Radio, Episode One: Jonathan Harker's Journal." },
    { kind: "music", cue: "theme" },
  ],
  scenes: [
    {
      id: "inn",
      title: "The inn at Bistritz",
      ambience: { kind: "sfx", id: "rain" },
      segments: [
        { kind: "narration", text: "Jonathan Harker reaches the inn at dusk, tired from the long road east." },
        { kind: "dialogue", speaker: "The landlady", text: "Must you go? Oh! young Herr, must you go?", delivery: "fearful" },
        { kind: "dialogue", speaker: "Jonathan Harker", text: "My business is important, and I must go at once." },
        { kind: "sfx", sfxId: "door_creak" },
      ],
    },
    {
      id: "castle",
      title: "The castle door",
      segments: [
        { kind: "pause", ms: 800 },
        { kind: "dialogue", speaker: "Count Dracula", text: "Welcome to my house! Enter freely and of your own will!", delivery: "sinister" },
      ],
    },
  ],
  close: [
    { kind: "announcer", text: "What waits behind the castle door? Tune in next time to Midnight Radio." },
    { kind: "music", cue: "theme" },
  ],
};

const hasSound = hasFfmpeg;

describe.skipIf(!hasSound)("a whole episode from stub voices (Task 9.5)", () => {
  let dir: string;
  let out: EpisodeOutput;
  let speech: Map<string, AudioFile>;
  let catalogue: SfxCatalogue;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-episode-"));
    const sfxDir = join(dir, "sfx");
    await mkdir(join(sfxDir, "beds"), { recursive: true });
    await mkdir(join(sfxDir, "foley"), { recursive: true });
    await mkdir(join(sfxDir, "music"), { recursive: true });
    const wav = (seconds: number, f: (t: number) => number) => encodeWav(Int16Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => Math.round(f(i / SAMPLE_RATE) * 32767)));
    let seed = 1;
    const noise = () => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    await writeFile(join(sfxDir, "beds/rain.wav"), wav(3, () => 0.4 * noise()));
    await writeFile(join(sfxDir, "foley/door_creak.wav"), wav(1.5, (t) => 0.5 * Math.sin(2 * Math.PI * (300 + 200 * t) * t) * Math.exp(-t)));
    await writeFile(join(sfxDir, "music/theme.wav"), wav(3, (t) => 0.3 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t)) * Math.min(1, 3 - t)));
    const entry = (id: string, kind: "sfx" | "music", path: string, durationMs: number, loopable: boolean): SfxEntry => ({ id, kind, title: id, path, sha256: "a".repeat(64), durationMs, loopable, peakDb: -1, tags: [], source: { type: "project", author: "test", licence: "CC0-1.0" } });
    catalogue = { version: 1, id: "test-lib", entries: [entry("rain", "sfx", "beds/rain.wav", 3000, true), entry("door_creak", "sfx", "foley/door_creak.wav", 1500, false), entry("theme", "music", "music/theme.wav", 3000, false)], musicCues: { theme: "theme" } };

    // Speech through the real render cache with the offline StubProvider.
    const cache = new RenderCache({ dir: join(dir, "cache"), provider: new StubProvider() });
    const lines = segmentsInOrder(SCRIPT).flatMap(({ ref, segment: s }) => {
      if (s.kind !== "announcer" && s.kind !== "narration" && s.kind !== "dialogue") return [];
      const voiceId = VOICES[s.kind === "dialogue" ? s.speaker : s.kind === "announcer" ? "Announcer" : "Narrator"]!;
      return [{ id: ref.path, voiceId, text: s.text, ...(s.delivery ? { delivery: s.delivery } : {}) }];
    });
    const outcomes = await renderSegments(lines, { cache });
    speech = new Map(outcomes.map((o) => {
      if (o.status === "failed") throw new Error(o.error.message);
      return [o.id, { path: o.result.path, frames: o.result.info.frames }];
    }));
    const outDir = join(dir, "out");
    await mkdir(outDir);
    out = await mixEpisode({ script: SCRIPT, speech, sfx: catalogue, sfxDir, workDir: dir, outDir, tags: { title: "Episode 1: Jonathan Harker's Journal", album: "Midnight Radio", artist: "Bram Stoker", track: 1, aiDisclosure: "AI-generated adaptation of a public-domain text." } }, { log: () => {} });
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("masters both variants to −16 LUFS ±1 and true peak ≤ −1 dBTP, measured on the decoded MP3s", async () => {
    for (const v of [out.clean, out.am]) {
      const m = await measureLoudness(v.path);
      expect(Math.abs(m.integratedLufs - TARGET_LUFS), v.path).toBeLessThanOrEqual(LUFS_TOLERANCE);
      expect(m.truePeakDbtp, v.path).toBeLessThanOrEqual(MAX_TRUE_PEAK);
    }
  });

  it("gives both variants the same length as the timeline", async () => {
    const [c, a] = await Promise.all([probeAudio(out.clean.path), probeAudio(out.am.path)]);
    expect(c.durationMs).toBe(a.durationMs);
    expect(Math.abs(c.durationMs - framesToMs(out.timeline.totalFrames))).toBeLessThanOrEqual(30);
  });

  it("ducks the bed at least 12 dB under speech, measured in the rendered bed stem", async () => {
    const beds = join(dir, "beds-only.wav");
    await renderMix(out.timeline, beds, { beds: (id) => ({ path: join(dir, "sfx", catalogue.entries.find((e) => e.id === id)!.path), frames: SAMPLE_RATE * 3 }), workDir: dir, stem: "beds", log: () => {} });
    const s = await readFloat(beds);
    const scene = out.timeline.scenes[0]!;
    const inScene = speechRanges(out.timeline).filter((r) => r.start >= scene.startFrame && r.end <= scene.endFrame);
    const door = out.timeline.items.find((i) => i.kind === "sfx")!;
    // full level: during the door creak, after the release, away from the scene's fade-out
    const open = rms(s, door.startFrame + msToFrames(400), door.startFrame + msToFrames(900));
    for (const r of inScene) expect(gainToDb(open / rms(s, r.start + msToFrames(40), r.end))).toBeGreaterThanOrEqual(12);
  });

  it("lines up the transcript and chapter markers with the decoded MP3, encoder delay included", async () => {
    const decoded = join(dir, "decoded.wav");
    await runFfmpeg({ inputs: [{ path: out.clean.path }], filter: { type: "audio", graph: `aresample=${SAMPLE_RATE}` }, outputOptions: ["-ac", "1", "-c:a", "pcm_f32le"], output: decoded }, { log: () => {} });
    const s = await readFloat(decoded);
    const vtt = await readFile(out.vttPath, "utf8");
    // The close's first line follows a silent 600 ms scene gap, so its onset is unambiguous.
    const closeLine = out.timeline.items.find((i) => i.ref.section === "close" && i.kind === "speech")!;
    const cueStart = vttStart(vtt, "What waits behind the castle door?");
    expect(cueStart).toBeCloseTo(framesToMs(closeLine.startFrame), 0);
    const heard = framesToMs(onset(s, closeLine.startFrame - msToFrames(300), 0.003));
    expect(Math.abs(heard - cueStart)).toBeLessThanOrEqual(15);
    expect(out.chapters.find((c) => c.title === "Close")!.startMs).toBe(Math.round(framesToMs(closeLine.startFrame)));
    // every speech line has a cue, in order
    expect((vtt.match(/ --> /g) ?? []).length).toBe(speech.size);
    expect(out.chapters.map((c) => c.title)).toEqual(["Cold open", "The inn at Bistritz", "The castle door", "Close"]);
  });

  it("makes the AM variant a broadcast: crackle in the silence between scenes, which the clean mix keeps silent", async () => {
    const closeLine = out.timeline.items.find((i) => i.ref.section === "close" && i.kind === "speech")!;
    const gap: [number, number] = [framesToMs(closeLine.startFrame) / 1000 - 0.5, framesToMs(closeLine.startFrame) / 1000 - 0.1];
    const level = async (path: string) => {
      const r = await runFfmpeg({ inputs: [{ path }], filter: { type: "audio", graph: `atrim=start=${gap[0]}:end=${gap[1]},astats=metadata=0:measure_overall=RMS_level:measure_perchannel=none` }, output: null, logLevel: "info" }, { log: () => {} });
      const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(r.log)!;
      return m[1] === "-inf" ? -Infinity : Number(m[1]);
    };
    const clean = await level(out.clean.path);
    const am = await level(out.am.path);
    expect(clean).toBeLessThan(-70);
    expect(am).toBeGreaterThan(clean + 15);
    expect(am).toBeLessThan(-30);
  });

  it("keeps the stub audio non-silent, so loudness measurement is meaningful", async () => {
    const m = await measureLoudness(join(dir, "clean.wav"));
    expect(m.integratedLufs).toBeGreaterThan(-40);
  });
});

async function readFloat(path: string): Promise<Float32Array> {
  const b = await readFile(path);
  let pos = 12;
  while (pos + 8 <= b.length) {
    const tag = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (tag === "data") {
      const n = Math.floor(Math.min(size, b.length - pos - 8) / 4);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readFloatLE(pos + 8 + i * 4);
      return out;
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}
function rms(s: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += s[i]! * s[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}
function onset(s: Float32Array, from: number, threshold: number): number {
  for (let i = Math.max(0, from); i < s.length; i++) if (Math.abs(s[i]!) > threshold) return i;
  return -1;
}
function vttStart(vtt: string, text: string): number {
  const cue = vtt.split("\n\n").find((c) => c.includes(text))!;
  const [, h, m, sec, ms] = /(\d\d):(\d\d):(\d\d)\.(\d{3}) -->/.exec(cue)!;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000 + Number(ms);
}
