import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SfxCatalogueSchema } from "@midnight-radio/core";
import { encodeWav } from "@midnight-radio/tts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AssembleError } from "./assemble-sfx.js";
import { buildSfx, pythonGenerate, type GenerateStep, type SfxBuildPaths } from "./sfx-build.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
if (process.env.REQUIRE_PYTHON_CONTRACT === "1" && !hasUv) throw new Error("REQUIRE_PYTHON_CONTRACT=1 but uv is not installed");
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");
const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../services/local-audio");
const quiet = { log: () => {} };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const CUES = [
  { id: "door_creak", prompt: "A heavy door creaks open.", durationSec: 2, seed: 100, loopable: false },
  { id: "rain_bed", prompt: "Steady rain on a window.", durationSec: 6, seed: 200, loopable: true },
];

/** A repo-like layout in a temp folder: prompts, music sources and synthetic CC0 music. */
async function layout(root: string): Promise<SfxBuildPaths> {
  const paths = { sfxDir: join(root, "assets/sfx"), candidatesDir: join(root, "cand"), musicDir: join(root, "music"), attribution: join(root, "ATTRIBUTION.md") };
  await mkdir(paths.sfxDir, { recursive: true });
  await mkdir(paths.musicDir, { recursive: true });
  await writeFile(paths.attribution, "# Attribution\n\n## Sound effects and music\n\nNone bundled yet.\n");
  await writeFile(join(paths.sfxDir, "prompts.json"), JSON.stringify({ version: 1, cues: CUES }));
  const RATE = 44_100;
  const tone = (s: number, amp: number) => Int16Array.from({ length: Math.round(s * RATE) }, (_, i) => Math.round(amp * 32767 * Math.sin((2 * Math.PI * 196 * i) / RATE)));
  const items = [];
  for (const [file, seconds, cue] of [["overture.wav", 25, "theme"], ["riff.wav", 1.5, "sting"], ["fugue.wav", 6, "transition"]] as const) {
    const bytes = encodeWav(tone(seconds, 0.4), RATE);
    await writeFile(join(paths.musicDir, file), bytes);
    items.push({ file, title: `Test ${cue}`, sourcePage: `https://example.org/${file}`, author: "Tester", licence: "CC0-1.0", sha256: sha(bytes), cues: [cue] });
  }
  await writeFile(join(paths.sfxDir, "music-sources.json"), JSON.stringify({ version: 1, items }));
  return paths;
}

describe("buildSfx: generation outcomes (no server)", () => {
  let root: string;
  let paths: SfxBuildPaths;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mr-build-"));
    paths = await layout(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const steps = (...codes: number[]) => {
    const calls: number[] = [];
    const step: GenerateStep = async () => {
      calls.push(codes[calls.length] ?? 0);
      return calls[calls.length - 1]!;
    };
    return { step, calls };
  };

  it("stops when generation stops, without writing the library", async () => {
    const { step, calls } = steps(2);
    await expect(buildSfx(paths, { generate: step, log: () => {}, ff: quiet })).rejects.toThrow(new AssembleError("foley generation stopped (see the message above); nothing was assembled"));
    expect(calls).toEqual([2]);
    expect(existsSync(join(paths.sfxDir, "index.json"))).toBe(false);
  });

  it("retries once after failed takes, and stops if the retry is stopped", async () => {
    const { step, calls } = steps(1, 2);
    await expect(buildSfx(paths, { generate: step, log: () => {}, ff: quiet })).rejects.toThrow(/generation stopped/);
    expect(calls).toEqual([1, 2]);
  });

  it("stops when generation succeeded but left no takes.json", async () => {
    const { step } = steps(0);
    await expect(buildSfx(paths, { generate: step, log: () => {}, ff: quiet })).rejects.toThrow(/wrote no usable takes\.json/);
  });

  it("refuses takes from the fake test backend unless allowed", async () => {
    await mkdir(paths.candidatesDir);
    await writeFile(join(paths.candidatesDir, "takes.json"), JSON.stringify({ model: { model: "fake-sfx", revision: "fake-1" }, takes: {} }));
    const { step } = steps(0);
    await expect(buildSfx(paths, { generate: step, log: () => {}, ff: quiet })).rejects.toThrow(/"fake-sfx", the local service's test backend/);
    expect(existsSync(join(paths.sfxDir, "index.json"))).toBe(false);
  });

  it.skipIf(!hasFfmpeg)("builds from the takes that exist when some still fail after the retry, and says so", async () => {
    const RATE = 48_000;
    let seed = 3;
    const noise = (s: number) => Int16Array.from({ length: s * RATE }, () => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) % 8000) - 4000);
    await mkdir(join(paths.candidatesDir, "door_creak"), { recursive: true });
    const bytes = encodeWav(noise(2), RATE);
    await writeFile(join(paths.candidatesDir, "door_creak/take-1.wav"), bytes);
    const take = { prompt: CUES[0]!.prompt, durationSec: 2, seed: 100, file: "take-1.wav", sha256: sha(bytes), at: "2026-11-20T00:00:00Z" };
    await writeFile(join(paths.candidatesDir, "takes.json"), JSON.stringify({ model: { model: "real-sfx", revision: "r1", weightsSha256: null, license: "Apache-2.0", sampleRate: RATE }, takes: { door_creak: { "1": take } } }));
    const { step, calls } = steps(1, 1);
    const r = await buildSfx(paths, { generate: step, log: () => {}, ff: quiet });
    expect(calls).toEqual([1, 1]);
    expect(r).toMatchObject({ generationIncomplete: true, foley: { assembled: ["door_creak"], unpicked: ["rain_bed"] } });
    expect(r.music).toHaveLength(3);
  });

  it("reports a missing generator program clearly", async () => {
    const step = pythonGenerate({ serviceDir: root, prompts: "p", out: "o", takes: 1, env: { PATH: "/nonexistent" } });
    await expect(step()).rejects.toThrow(/uv is not installed/);
  });
});

describe.skipIf(!hasFfmpeg || !hasUv)("buildSfx end to end (real generator, local service fake backend, real ffmpeg)", () => {
  let root: string;
  let child: ChildProcess;
  let url: string;
  const TOKEN = "build-test-token-0123456789";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mr-build-e2e-"));
    const clip = new TextEncoder().encode("not really a clip");
    await mkdir(join(root, "svc/clips"), { recursive: true });
    await writeFile(join(root, "svc/clips/v.wav"), clip);
    await writeFile(join(root, "svc/catalogue.json"), JSON.stringify({ voices: [{ id: "narrator", clip: { file: "clips/v.wav", sha256: sha(clip), transcript: "Good evening." } }] }));
    child = spawn("uv", ["run", "--no-project", "--python", ">=3.10", "python", "-m", "local_audio", "--catalogue", join(root, "svc/catalogue.json"), "--backend", "fake", "--port", "0"], {
      cwd: serviceDir,
      env: { ...process.env, LOCAL_AUDIO_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const stderr: string[] = [];
    child.stderr!.on("data", (d: Buffer) => stderr.push(d.toString()));
    url = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`service did not start:\n${stderr.join("")}`)), 100_000);
      let buf = "";
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        if (buf.includes("\n")) {
          clearTimeout(timer);
          ok((JSON.parse(buf.split("\n")[0]!) as { listening: string }).listening);
        }
      });
      child.on("exit", (code) => fail(new Error(`service exited (${code}):\n${stderr.join("")}`)));
    });
  }, 120_000);
  afterAll(async () => {
    if (child?.pid && child.exitCode === null) {
      process.kill(-child.pid, "SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
    await rm(root, { recursive: true, force: true });
  });

  it("generates, picks, assembles and imports music, and a second run changes nothing", async () => {
    const paths = await layout(join(root, "repo"));
    const generate = pythonGenerate({ serviceDir, prompts: join(paths.sfxDir, "prompts.json"), out: paths.candidatesDir, takes: 2, env: { ...process.env, SFX_SERVICE_URL: url, SFX_SERVICE_TOKEN: TOKEN } });
    const r = await buildSfx(paths, { generate, allowFakeModel: true, log: () => {}, ff: quiet });
    expect(r).toMatchObject({ foley: { assembled: ["door_creak", "rain_bed"], unpicked: [] }, generationIncomplete: false });
    expect(r.music.map((m) => m.cue).sort()).toEqual(["sting", "theme", "transition"]);
    const cat = SfxCatalogueSchema.parse(JSON.parse(await readFile(join(paths.sfxDir, "index.json"), "utf8")));
    expect(cat.id).toBe(r.catalogueId);
    expect(cat.musicCues).toEqual({ theme: "theme_overture", sting: "sting_riff", transition: "transition_fugue" });
    expect(cat.entries.map((e) => e.id).sort()).toEqual(["door_creak", "rain_bed", "sting_riff", "theme_overture", "transition_fugue"]);
    expect(Object.values(JSON.parse(await readFile(join(paths.sfxDir, "picks.json"), "utf8")).picks).every((n) => n === 1 || n === 2)).toBe(true);
    const before = await readFile(join(paths.sfxDir, "index.json"), "utf8");
    const again = await buildSfx(paths, { generate, allowFakeModel: true, log: () => {}, ff: quiet });
    expect(again.catalogueId).toBe(r.catalogueId);
    expect(await readFile(join(paths.sfxDir, "index.json"), "utf8")).toBe(before);
  }, 300_000);

  it("stops with the generator's message when the server is unreachable", async () => {
    const paths = await layout(join(root, "repo2"));
    const generate = pythonGenerate({ serviceDir, prompts: join(paths.sfxDir, "prompts.json"), out: paths.candidatesDir, takes: 1, env: { ...process.env, SFX_SERVICE_URL: "http://127.0.0.1:9", SFX_SERVICE_TOKEN: "" } });
    await expect(buildSfx(paths, { generate, allowFakeModel: true, log: () => {}, ff: quiet })).rejects.toThrow(/generation stopped/);
    expect(existsSync(join(paths.sfxDir, "index.json"))).toBe(false);
  }, 120_000);
});
