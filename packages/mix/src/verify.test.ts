import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SfxCatalogue } from "@midnight-radio/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFloatWav } from "./envelope.js";
import { masterToMp3 } from "./master.js";
import { SAMPLE_RATE, type Timeline } from "./timeline.js";
import { EpisodeVerificationError, soundReport, verifyEpisode } from "./verify.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");

const SECONDS = 6;
const stem = () =>
  Float32Array.from({ length: SECONDS * SAMPLE_RATE }, (_, i) => {
    const t = i / SAMPLE_RATE;
    return 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) * (Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 1500 * t));
  });
const ref = { section: "scenes" as const, sceneIdx: 0, idx: 0, path: "scenes[0].segments[0]" };
const timeline = (seconds = SECONDS): Timeline => ({
  sampleRate: SAMPLE_RATE,
  totalFrames: seconds * SAMPLE_RATE,
  items: [
    { kind: "speech", ref, startFrame: 0, frames: SAMPLE_RATE, file: "x.wav", segmentKind: "narration", speaker: null, text: "Rain." },
    { kind: "music", ref: { ...ref, idx: 1, path: "scenes[0].segments[1]" }, startFrame: SAMPLE_RATE, frames: SAMPLE_RATE, file: "t.wav", fileFrames: SAMPLE_RATE, loop: false, id: "theme" },
    { kind: "sfx", ref: { ...ref, idx: 2, path: "scenes[0].segments[2]" }, startFrame: 2 * SAMPLE_RATE, frames: SAMPLE_RATE / 2, file: "k.wav", fileFrames: SAMPLE_RATE / 2, loop: false, id: "knock" },
  ],
  scenes: [{ sceneIdx: 0, id: "s1", title: undefined, startFrame: 0, endFrame: SECONDS * SAMPLE_RATE, ambience: { kind: "sfx", id: "rain", gainDb: -18 } } as Timeline["scenes"][number]],
});
const entry = (id: string, kind: "sfx" | "music", loopable = false) => ({ id, kind, title: id, path: `${kind}/${id}.wav`, sha256: id.padEnd(64, "0").replace(/[^0-9a-f]/g, "a"), durationMs: 1000, loopable, peakDb: -1, tags: [], source: { type: "project" as const, author: "t", licence: "CC0-1.0" as const } });
const LIB = { version: 1, id: "lib", entries: [entry("knock", "sfx"), entry("rain", "sfx", true), entry("theme_x", "music")], musicCues: { theme: "theme_x" } } as SfxCatalogue;

describe("the sound report", () => {
  it("lists each sound on the timeline with its asset, hash and licence, resolving music cues to their pinned asset", () => {
    const r = soundReport(timeline(), LIB);
    expect(r.sounds.map((s) => [s.kind, s.id, s.cue, s.startMs, s.durationMs])).toEqual([
      ["music", "theme_x", "theme", 1000, 1000],
      ["sfx", "knock", undefined, 2000, 500],
    ]);
    expect(r.beds).toEqual([{ sceneId: "s1", id: "rain", startMs: 0, endMs: 6000, gainDb: -18, sha256: LIB.entries[1]!.sha256, licence: "CC0-1.0" }]);
    expect(() => soundReport(timeline(), { ...LIB, entries: LIB.entries.slice(1) })).toThrow(EpisodeVerificationError);
  });
});

describe.skipIf(!hasFfmpeg)("episode verification (real ffmpeg)", () => {
  let dir: string;
  const files = () => ({ cleanPath: join(dir, "episode.mp3"), amPath: join(dir, "episode-am.mp3"), vttPath: join(dir, "episode.vtt") });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-verify-"));
    await writeFile(join(dir, "stem.wav"), encodeFloatWav(stem()));
    await masterToMp3(join(dir, "stem.wav"), files().cleanPath, { tags: { title: "t", album: "a", artist: "x", track: 1, aiDisclosure: "AI" }, chapters: [], workDir: dir }, { log: () => {} });
    await copyFile(files().cleanPath, files().amPath);
    await writeFile(files().vttPath, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nRain.\n");
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes complete files that match the timeline and meet the loudness targets", async () => {
    const v = await verifyEpisode(files(), timeline(), { log: () => {} });
    expect(Math.abs(v.clean.durationMs - SECONDS * 1000)).toBeLessThanOrEqual(150);
    expect(Math.abs(v.clean.integratedLufs + 16)).toBeLessThanOrEqual(1);
    expect(v.clean.truePeakDbtp).toBeLessThanOrEqual(-1);
    expect(v.transcriptCues).toBe(1);
  }, 60_000);

  it("fails a truncated file, a length that does not match the timeline, a missed loudness target and a short transcript", async () => {
    const bytes = await readFile(files().cleanPath);
    const cut = join(dir, "cut.mp3");
    await writeFile(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(verifyEpisode({ ...files(), cleanPath: cut }, timeline(), { log: () => {} })).rejects.toBeInstanceOf(EpisodeVerificationError);
    await expect(verifyEpisode(files(), timeline(SECONDS + 1), { log: () => {} })).rejects.toThrow(/timeline is 7000 ms/);
    await expect(verifyEpisode(files(), timeline(), { log: () => {}, targets: { lufs: -23, tolerance: 1, maxTruePeak: -1 } })).rejects.toThrow(/LUFS/);
    const twoLines = timeline();
    twoLines.items.push({ ...(twoLines.items[0] as Extract<Timeline["items"][number], { kind: "speech" }>), startFrame: 3 * SAMPLE_RATE });
    await expect(verifyEpisode(files(), twoLines, { log: () => {} })).rejects.toThrow(/1 cues for 2 spoken lines/);
  }, 60_000);
});
