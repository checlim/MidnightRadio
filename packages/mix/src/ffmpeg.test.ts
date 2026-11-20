import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FfmpegError, buildArgs, probeAudio, runFfmpeg } from "./ffmpeg.js";

/** Tests that run ffmpeg are skipped where it is not installed; REQUIRE_FFMPEG=1 turns that into a failure (CI). */
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg/ffprobe are not on the PATH");

/** Mono 16-bit PCM WAV with a 440 Hz tone. */
function toneWav(seconds: number, rate: number): Buffer {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe("buildArgs", () => {
  it("passes files with the file: protocol, generated sources through lavfi, and the filter after the inputs", () => {
    expect(
      buildArgs({
        inputs: [{ path: "-tricky name.wav" }, { lavfi: "anullsrc=r=24000:cl=mono", options: ["-t", "2"] }],
        filter: { type: "complex", graph: "[0:a][1:a]concat=n=2:v=0:a=1[out]" },
        outputOptions: ["-map", "[out]", "-c:a", "pcm_s16le"],
        output: "http://example.com/out.wav",
      }),
    ).toEqual([
      "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y",
      "-i", "file:-tricky name.wav",
      "-t", "2", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
      "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]",
      "-map", "[out]", "-c:a", "pcm_s16le",
      "file:http://example.com/out.wav",
    ]);
  });

  it("discards output for measurements, and refuses jobs without inputs or with unusable paths", () => {
    expect(buildArgs({ inputs: [{ path: "a.wav" }], filter: { type: "audio", graph: "ebur128" }, output: null, logLevel: "info" }).slice(-6)).toEqual(["file:a.wav", "-af", "ebur128", "-f", "null", "-"]);
    expect(() => buildArgs({ inputs: [], output: "x.wav" })).toThrow(/at least one input/);
    expect(() => buildArgs({ inputs: [{ path: "" }], output: "x.wav" })).toThrow(/non-empty/);
    expect(() => buildArgs({ inputs: [{ path: "a\0b.wav" }], output: "x.wav" })).toThrow(/NUL/);
  });
});

describe.skipIf(!hasFfmpeg)("runFfmpeg and probeAudio (real ffmpeg)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-ffmpeg-"));
    await writeFile(join(dir, "tone48k.wav"), toneWav(2, 48_000));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resamples 48 kHz to the 24 kHz mono 16-bit working format", async () => {
    const out = join(dir, "tone24k.wav");
    await runFfmpeg({ inputs: [{ path: join(dir, "tone48k.wav") }], filter: { type: "audio", graph: "aresample=24000:filter_size=64:cutoff=0.97" }, outputOptions: ["-ac", "1", "-c:a", "pcm_s16le"], output: out });
    expect(await probeAudio(out)).toEqual({ format: "wav", codec: "pcm_s16le", sampleRate: 24_000, channels: 1, bitsPerSample: 16, durationMs: 2000 });
  });

  it("treats odd file names as files: a leading dash is not an option and a URL is never fetched", async () => {
    const odd = join(dir, "-x.wav");
    await writeFile(odd, toneWav(0.5, 24_000));
    expect((await probeAudio(odd)).durationMs).toBe(500);
    const logs: string[] = [];
    await expect(probeAudio("http://127.0.0.1:9/nothing.wav", { log: (m) => logs.push(m) })).rejects.toThrow(FfmpegError);
    expect(logs[0]).toMatch(/file:http:\/\/127\.0\.0\.1:9\/nothing\.wav/);
  });

  it("logs the full command and filter graph when ffmpeg fails, and carries them on the error", async () => {
    const logs: string[] = [];
    const graph = "aresample=24000,thisfilterdoesnotexist=1";
    const err = await runFfmpeg({ inputs: [{ path: join(dir, "tone48k.wav") }], filter: { type: "audio", graph }, output: join(dir, "never.wav") }, { log: (m) => logs.push(m) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect((err as FfmpegError).filterGraph).toBe(graph);
    expect((err as FfmpegError).exitCode).not.toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`filter graph: ${graph}`);
    expect(logs[0]).toMatch(/command: ffmpeg .*-af aresample=24000,thisfilterdoesnotexist=1 /);
    expect(logs[0]).toMatch(/thisfilterdoesnotexist/i);
    expect(existsSync(join(dir, "never.wav"))).toBe(false);
  });

  it("stops a job that runs past its timeout", async () => {
    const logs: string[] = [];
    const started = Date.now();
    const err = await runFfmpeg({ inputs: [{ lavfi: "anoisesrc=r=48000:d=36000" }], filter: { type: "audio", graph: "aresample=24000" }, output: null, timeoutMs: 300 }, { log: (m) => logs.push(m) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect((err as FfmpegError).signal).toBe("SIGKILL");
    expect(logs[0]).toMatch(/longer than 300 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("measures without writing a file and returns ffmpeg's log", async () => {
    const r = await runFfmpeg({ inputs: [{ path: join(dir, "tone48k.wav") }], filter: { type: "audio", graph: "astats=metadata=0:measure_overall=Peak_level:measure_perchannel=none" }, output: null, logLevel: "info" });
    expect(r.log).toMatch(/Peak level dB:\s*-12\.2/);
  });

  it("reports a missing program clearly", async () => {
    const logs: string[] = [];
    await expect(runFfmpeg({ inputs: [{ path: join(dir, "tone48k.wav") }], output: null }, { ffmpegPath: "/nonexistent/ffmpeg", log: (m) => logs.push(m) })).rejects.toThrow(/could not start ffmpeg \(ENOENT\)/);
    await expect(probeAudio(join(dir, "tone48k.wav"), { ffprobePath: "/nonexistent/ffprobe", log: () => {} })).rejects.toThrow(/could not start ffprobe/);
  });

  it("refuses a file that is not audio", async () => {
    const text = join(dir, "notes.wav");
    await writeFile(text, "not audio at all");
    await expect(probeAudio(text, { log: () => {} })).rejects.toThrow(FfmpegError);
    const video = join(dir, "picture.nut");
    await runFfmpeg({ inputs: [{ lavfi: "color=c=black:s=16x16:d=0.2" }], outputOptions: ["-c:v", "rawvideo", "-f", "nut"], output: video });
    await expect(probeAudio(video, { log: () => {} })).rejects.toThrow(new FfmpegError("the file has no audio stream", [], null, null, null, "").message);
  });
});
