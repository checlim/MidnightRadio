/*
 * Re-run these tests (the whole mix suite) against FFmpeg 4.4.2, the production version:
 *   packages/mix/src/test-support/run-ffmpeg44.sh
 * It builds a cached Docker image (src/test-support/ffmpeg44.Dockerfile) and runs vitest in a copy of the repo.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFloatWav } from "./envelope.js";
import { probeAudio, runFfmpeg } from "./ffmpeg.js";
import { LUFS_TOLERANCE, MAX_TRUE_PEAK, MP3_RATE, MasteringError, TARGET_LUFS, masterToMp3, measureLoudness, meetsTargets, parseEbur128Summary, renderAm } from "./master.js";
import { SAMPLE_RATE } from "./timeline.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");

/** Speech-like test audio: harmonics with a syllable-rate envelope, with a second of silence in the middle. */
function voiceStem(seconds: number): Float32Array {
  return Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => {
    const t = i / SAMPLE_RATE;
    if (t > 4 && t < 5) return 0;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    return 0.3 * env * (Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 1500 * t) + 0.4 * Math.sin(2 * Math.PI * 6000 * t));
  });
}
const sha = async (p: string) => createHash("sha256").update(await readFile(p)).digest("hex");

/** RMS level (dBFS) of a file after a filter, measured by ffmpeg. */
async function levelDb(path: string, filter: string, trim?: [number, number]): Promise<number> {
  const pre = trim ? `atrim=start=${trim[0]}:end=${trim[1]},` : "";
  const r = await runFfmpeg({ inputs: [{ path }], filter: { type: "audio", graph: `${pre}${filter}astats=metadata=0:measure_overall=RMS_level:measure_perchannel=none` }, output: null, logLevel: "info" });
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(r.log);
  return m![1] === "-inf" ? -Infinity : Number(m![1]);
}

describe.skipIf(!hasFfmpeg)("Vintage AM and mastering (real ffmpeg)", () => {
  let dir: string;
  const clean = () => join(dir, "clean.wav");
  const am = () => join(dir, "am.wav");
  const tags = { title: "Episode 1: Jonathan Harker\u2019s Journal", album: "Midnight Radio", artist: "Bram Stoker", track: 1, aiDisclosure: "AI-generated adaptation of a public-domain text." };
  const chapters = [{ title: "Cold open", startMs: 0, endMs: 3000 }, { title: "The inn", startMs: 3000, endMs: 10_000 }];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-master-"));
    await writeFile(clean(), encodeFloatWav(voiceStem(10)));
    await renderAm(clean(), am(), { log: () => {} });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the AM variant exactly as long as the clean mix", async () => {
    expect((await probeAudio(am())).durationMs).toBe((await probeAudio(clean())).durationMs);
    const b = await readFile(am());
    // Float, still inside the pipeline. FFmpeg 4.4.2 writes 32-bit float WAV as WAVE_FORMAT_EXTENSIBLE (0xFFFE) with
    // the float sub-format (3) in the GUID; FFmpeg 9 writes plain format 3. Both are the same samples.
    const tag = b.readUInt16LE(20);
    expect(tag === 3 || (tag === 0xfffe && b.readUInt16LE(44) === 3)).toBe(true);
  });

  it("band-limits AM to the telephone band: little left below 300 Hz or above 3,400 Hz", async () => {
    const lowClean = await levelDb(clean(), "lowpass=f=200,lowpass=f=200,");
    const lowAm = await levelDb(am(), "lowpass=f=200,lowpass=f=200,");
    const highClean = await levelDb(clean(), "highpass=f=5000,highpass=f=5000,");
    const highAm = await levelDb(am(), "highpass=f=5000,highpass=f=5000,");
    expect(lowClean - lowAm).toBeGreaterThan(15);
    expect(highClean - highAm).toBeGreaterThan(20);
    const midClean = await levelDb(clean(), "bandpass=f=1500:width_type=q:w=2,");
    const midAm = await levelDb(am(), "bandpass=f=1500:width_type=q:w=2,");
    expect(Math.abs(midClean - midAm)).toBeLessThan(3);
  });

  it("adds a low crackle bed, heard in the silence, and is repeatable", async () => {
    expect(await levelDb(clean(), "", [4.2, 4.8])).toBe(-Infinity);
    const quiet = await levelDb(am(), "", [4.2, 4.8]);
    expect(quiet).toBeGreaterThan(-75);
    expect(quiet).toBeLessThan(-40);
    const again = join(dir, "am2.wav");
    await renderAm(clean(), again, { log: () => {} });
    expect(await sha(again)).toBe(await sha(am()));
  });

  it("masters both variants to −16 LUFS ±1 with true peak ≤ −1 dBTP, measured on the decoded MP3", async () => {
    for (const [name, stem] of [["clean", clean()], ["am", am()]] as const) {
      const mp3 = join(dir, `${name}.mp3`);
      const r = await masterToMp3(stem, mp3, { tags, chapters, workDir: dir }, { log: () => {} });
      const measured = await measureLoudness(mp3);
      expect(Math.abs(measured.integratedLufs - TARGET_LUFS), name).toBeLessThanOrEqual(LUFS_TOLERANCE);
      expect(measured.truePeakDbtp, name).toBeLessThanOrEqual(MAX_TRUE_PEAK);
      expect(r).toMatchObject(measured);
      const p = await probeAudio(mp3);
      expect(p).toMatchObject({ codec: "mp3", sampleRate: MP3_RATE, channels: 1 });
      // FFmpeg 4.4.2's ffprobe counts the encoder delay (about 25 ms) in an MP3's duration; newer versions do not.
      expect(Math.abs(p.durationMs - 10_000), name).toBeLessThanOrEqual(45);
    }
    expect((await readdir(dir)).filter((f) => f.startsWith("master-"))).toEqual([]);
  }, 120_000);

  it("writes 192 kbps with the AI disclosure, title tags and chapter markers", async () => {
    const r = await runFfmpeg({ inputs: [{ path: join(dir, "clean.mp3") }], output: null, logLevel: "info" });
    expect(r.log).toMatch(/bitrate: 19\d kb\/s/);
    for (const line of [/title\s*: Episode 1: Jonathan Harker\u2019s Journal/, /album\s*: Midnight Radio/, /artist\s*: Bram Stoker/, /comment\s*: AI-generated adaptation of a public-domain text\./, /AI_GENERATED\s*: yes/]) expect(r.log).toMatch(line);
    expect(r.log).toMatch(/Chapter #0:0: start 0\.000000, end 3\.000000\s+Metadata:\s+title\s*: Cold open/);
    expect(r.log).toMatch(/Chapter #0:1: start 3\.000000, end 10\.000000\s+Metadata:\s+title\s*: The inn/);
  });

  it("re-masters with a lower ceiling when the decoded MP3 misses, and refuses after three passes", async () => {
    const logs: string[] = [];
    const err = await masterToMp3(clean(), join(dir, "impossible.mp3"), { tags, chapters, workDir: dir, targets: { lufs: TARGET_LUFS, tolerance: LUFS_TOLERANCE, maxTruePeak: -40 } }, { log: (m) => logs.push(m) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MasteringError);
    expect((err as MasteringError).message).toMatch(/true peak ≤ -40 dBTP/);
    expect((err as MasteringError).measured.truePeakDbtp).toBeGreaterThan(-40);
  }, 120_000);

  it("judges the targets: −16 ±1 LUFS and true peak ≤ −1 dBTP", () => {
    expect(meetsTargets({ integratedLufs: -16.9, truePeakDbtp: -1 })).toBe(true);
    expect(meetsTargets({ integratedLufs: -17.1, truePeakDbtp: -2 })).toBe(false);
    expect(meetsTargets({ integratedLufs: -15, truePeakDbtp: -0.9 })).toBe(false);
  });

  it("refuses to master silence instead of shipping it", async () => {
    const silent = join(dir, "silent.wav");
    await writeFile(silent, encodeFloatWav(new Float32Array(SAMPLE_RATE * 2)));
    await expect(masterToMp3(silent, join(dir, "silent.mp3"), { tags, chapters: [], workDir: dir }, { log: () => {} })).rejects.toThrow();
  });
});

describe("parseEbur128Summary", () => {
  const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  it("reads the real FFmpeg 4.4.2 summary", async () => {
    expect(parseEbur128Summary(await fixture("ebur128-summary-ffmpeg-4.4.2.txt"))).toEqual({ integratedLufs: -31.8, truePeakDbtp: -28.1 });
  });
  it("reads the real FFmpeg 9.0.2 summary", async () => {
    expect(parseEbur128Summary(await fixture("ebur128-summary-ffmpeg-9.0.2.txt"))).toEqual({ integratedLufs: -31.7, truePeakDbtp: -28.1 });
  });
  it("uses the last summary and reads silence as -inf", () => {
    const log = "Summary:\n I: -20.0 LUFS\n Peak: -3.0 dBFS\n[x] Summary:\n  Integrated loudness:\n    I:         -70.0 LUFS\n  True peak:\n    Peak:      -inf dBFS\n";
    expect(parseEbur128Summary(log)).toEqual({ integratedLufs: -70, truePeakDbtp: -Infinity });
  });
  it("refuses a log without a summary", () => {
    expect(() => parseEbur128Summary("nothing here")).toThrow(/no summary/);
  });
});
