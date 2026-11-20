import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SfxCatalogueSchema, type SfxCatalogue } from "@midnight-radio/core";
import { validateWav } from "@midnight-radio/tts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssembleError, assembleSfx, attributionBlock, catalogueIdFor, findClicks, loopCrossfadeS, loopSeamRatio, titleFor, updateAttribution } from "./assemble-sfx.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function wav(samples: Float64Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2));
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
const signal = (seconds: number, rate: number, f: (t: number) => number) => Float64Array.from({ length: Math.round(seconds * rate) }, (_, i) => f(i / rate));
const int16 = (xs: number[]) => Int16Array.from(xs);

describe("helpers", () => {
  it("titles and loop crossfade lengths", () => {
    expect(titleFor("door_creak")).toBe("Door creak");
    expect([loopCrossfadeS(3), loopCrossfadeS(10), loopCrossfadeS(30)]).toEqual([0.5, 1, 2]);
  });

  it("finds sudden jumps but not a smooth sound", () => {
    const tone = Int16Array.from(signal(1, 24_000, (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t)), (s) => Math.round(s * 32767));
    expect(findClicks(tone, 24_000)).toEqual([]);
    const clicked = Int16Array.from(tone);
    clicked[12_000] = 32767;
    clicked[12_001] = -32768;
    expect(findClicks(clicked, 24_000)).toEqual([0.5]);
  });

  it("measures the loop seam against the sound's own movement", () => {
    expect(loopSeamRatio(int16([0, 100, 200, 100]))).toBeLessThanOrEqual(1);
    expect(loopSeamRatio(int16([0, 100, 200, 3000]))).toBeGreaterThan(1);
  });

  it("writes the attribution block, replaces only it, and escapes table cells", () => {
    const cat: SfxCatalogue = {
      version: 1,
      id: "x",
      musicCues: {},
      entries: [
        { id: "rain", kind: "sfx", title: "Rain | heavy", path: "beds/rain.wav", sha256: "a".repeat(64), durationMs: 28_000, loopable: true, peakDb: -1, tags: [], source: { type: "generated", model: "MOSS-SoundEffect-v2.0", revision: "e35df4d", licence: "Apache-2.0", prompt: "rain", seed: 1940, originalSha256: "b".repeat(64), generatedAt: "2026-11-20T10:00:00Z" } },
        { id: "bell", kind: "sfx", title: "Bell", path: "foley/bell.wav", sha256: "c".repeat(64), durationMs: 3000, loopable: false, peakDb: -1, tags: [], source: { type: "cc0", url: "https://freesound.org/s/1/", author: "someone", licence: "CC0-1.0" } },
      ],
    };
    const block = attributionBlock(cat);
    expect(block).toContain("1 sound made offline for this project with MOSS-SoundEffect-v2.0 (revision `e35df4d`)");
    expect(block).toContain("| Rain \\| heavy (`rain`) | `assets/sfx/beds/rain.wav` | generated, seed 1940 | Apache-2.0 |");
    expect(block).toContain("| Bell (`bell`) | `assets/sfx/foley/bell.wav` | <https://freesound.org/s/1/> by someone | CC0-1.0 |");
    expect(block.indexOf("Bell")).toBeLessThan(block.indexOf("Rain"));

    const md = "# Attribution\n\n## Voices\n\nVoices.\n\n## Sound effects and music\n\nNone bundled yet.\n\n## Later\n\nKeep me.\n";
    const once = updateAttribution(md, block);
    expect(once).not.toContain("None bundled yet.");
    expect(once).toContain("## Later\n\nKeep me.");
    expect(once).toContain("## Voices\n\nVoices.");
    const twice = updateAttribution(once, attributionBlock({ ...cat, entries: [] }));
    expect(twice).toContain("No sounds are bundled yet.");
    expect(twice).not.toContain("Rain");
    expect(twice.match(/sfx-library:begin/g)).toHaveLength(1);
    expect(() => updateAttribution("# nothing here\n", block)).toThrow(/no "## Sound effects and music"/);
  });

  it("gives the catalogue a new id whenever an entry or a music cue changes", () => {
    const a = catalogueIdFor([], {});
    expect(catalogueIdFor([], {})).toBe(a);
    expect(catalogueIdFor([], { theme: "x_y" })).not.toBe(a);
  });
});

describe.skipIf(!hasFfmpeg)("assembleSfx (real ffmpeg)", () => {
  let root: string;
  let paths: { sfxDir: string; candidatesDir: string; attribution: string };
  const CUES = [
    { id: "door_creak", prompt: "A door creaks.", durationSec: 2, seed: 1940, loopable: false, tags: ["door"] },
    { id: "rain", prompt: "Steady rain.", durationSec: 6, seed: 1940, loopable: true, tags: ["weather"] },
    { id: "owl_hoot", prompt: "An owl.", durationSec: 3, seed: 1940, loopable: false },
  ];
  // The door starts and stops at full level (a click without fades); the rain does not loop by itself.
  const door = wav(signal(2, 48_000, (t) => 0.6 * Math.sin(2 * Math.PI * 220 * t + 1)), 48_000);
  const rain = wav(signal(6, 48_000, (t) => 0.3 * Math.sin(2 * Math.PI * 300 * t) + 0.25 * Math.sin(2 * Math.PI * 437 * t + 0.5 * t)), 48_000);
  const model = { model: "stub-sfx", revision: "rev-1", weightsSha256: null, license: "Apache-2.0", sampleRate: 48_000 };
  const take = (cue: (typeof CUES)[number], n: number, bytes: Buffer) => ({ prompt: cue.prompt, durationSec: cue.durationSec, seed: cue.seed + n - 1, file: `take-${n}.wav`, sha256: sha(bytes), at: "2026-11-20T10:00:00Z" });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mr-assemble-"));
    paths = { sfxDir: join(root, "assets/sfx"), candidatesDir: join(root, "candidates"), attribution: join(root, "ATTRIBUTION.md") };
    await mkdir(paths.sfxDir, { recursive: true });
    await mkdir(join(paths.candidatesDir, "door_creak"), { recursive: true });
    await mkdir(join(paths.candidatesDir, "rain"), { recursive: true });
    await writeFile(join(paths.candidatesDir, "door_creak", "take-2.wav"), door);
    await writeFile(join(paths.candidatesDir, "rain", "take-1.wav"), rain);
    await writeTakes({ model, takes: { door_creak: { "2": take(CUES[0]!, 2, door) }, rain: { "1": take(CUES[1]!, 1, rain) } } });
    await writeFile(join(paths.sfxDir, "prompts.json"), JSON.stringify({ version: 1, cues: CUES }));
    await writeFile(join(paths.sfxDir, "picks.json"), JSON.stringify({ version: 1, picks: { door_creak: 2, rain: 1, owl_hoot: null } }));
    await writeFile(paths.attribution, "# Attribution\n\n## Sound effects and music\n\nNone bundled yet.\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const writeTakes = (t: unknown) => writeFile(join(paths.candidatesDir, "takes.json"), JSON.stringify(t));
  const index = async () => SfxCatalogueSchema.parse(JSON.parse(await readFile(join(paths.sfxDir, "index.json"), "utf8")));
  const samples = (bytes: Buffer) => {
    const info = validateWav(bytes, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    return new Int16Array(bytes.buffer.slice(bytes.byteOffset + info.dataOffset, bytes.byteOffset + info.dataOffset + info.dataLength));
  };

  it("converts, shapes, normalises and catalogues the picks, and records where they came from", async () => {
    const report = await assembleSfx(paths, { log: () => {} });
    expect(report.assembled.map((a) => [a.id, a.path, a.durationMs])).toEqual([["door_creak", "foley/door_creak.wav", 2000], ["rain", "beds/rain.wav", 5400]]);
    expect(report.skipped).toEqual(["owl_hoot"]);

    const cat = await index();
    expect(cat.id).toBe(report.catalogueId);
    const doorEntry = cat.entries.find((e) => e.id === "door_creak")!;
    expect(doorEntry).toMatchObject({ kind: "sfx", title: "Door creak", loopable: false, tags: ["door"], source: { type: "generated", model: "stub-sfx", revision: "rev-1", licence: "Apache-2.0", prompt: "A door creaks.", seed: 1941, originalSha256: sha(door) } });
    expect(Math.abs(doorEntry.peakDb + 1)).toBeLessThanOrEqual(0.3);

    const doorOut = await readFile(join(paths.sfxDir, "foley/door_creak.wav"));
    expect(sha(doorOut)).toBe(doorEntry.sha256);
    expect(validateWav(doorOut).dataOffset).toBe(44); // plain header: no encoder tag that changes with the ffmpeg version
    const d = samples(doorOut);
    expect(Math.abs(d[0]!)).toBeLessThan(330); // faded in: no click at the start
    expect(Math.abs(d[d.length - 1]!)).toBeLessThan(330); // faded out
    const r = samples(await readFile(join(paths.sfxDir, "beds/rain.wav")));
    expect(loopSeamRatio(r)).toBeLessThanOrEqual(1); // loops without a jump
    expect(cat.entries.find((e) => e.id === "rain")).toMatchObject({ loopable: true, path: "beds/rain.wav", durationMs: 5400 });

    const attribution = await readFile(paths.attribution, "utf8");
    expect(attribution).toContain("2 sounds made offline for this project with stub-sfx (revision `rev-1`)");
    expect(attribution).toContain("| Rain (`rain`) | `assets/sfx/beds/rain.wav` | generated, seed 1940 | Apache-2.0 |");
    expect((await readdir(join(paths.sfxDir, "foley"))).filter((f) => f.startsWith("."))).toEqual([]);
  });

  it("is repeatable: a second run writes identical files and the same catalogue id", async () => {
    const first = await assembleSfx(paths, { log: () => {} });
    const bytes = await readFile(join(paths.sfxDir, "beds/rain.wav"));
    const second = await assembleSfx(paths, { log: () => {} });
    expect(second.catalogueId).toBe(first.catalogueId);
    expect(sha(await readFile(join(paths.sfxDir, "beds/rain.wav")))).toBe(sha(bytes));
  });

  it("keeps sounds it did not make, and the music cues", async () => {
    const curated = { id: "main_theme", kind: "music", title: "Main theme", path: "music/theme.wav", sha256: "c".repeat(64), durationMs: 20_000, loopable: false, peakDb: -1, tags: [], source: { type: "project", author: "Midnight Radio", licence: "CC0-1.0" } };
    await writeFile(join(paths.sfxDir, "index.json"), JSON.stringify({ version: 1, id: "old", entries: [curated], musicCues: { theme: "main_theme" } }));
    await assembleSfx(paths, { log: () => {} });
    const cat = await index();
    expect(cat.entries.map((e) => e.id)).toEqual(["door_creak", "main_theme", "rain"]);
    expect(cat.musicCues).toEqual({ theme: "main_theme" });
    expect(await readFile(paths.attribution, "utf8")).toContain("made for the project by Midnight Radio");
  });

  it("keeps a title edited in index.json when the sound is assembled again", async () => {
    await assembleSfx(paths, { log: () => {} });
    const cat = await index();
    const edited = { ...cat, entries: cat.entries.map((e) => (e.id === "door_creak" ? { ...e, title: "Old oak door" } : e)) };
    await writeFile(join(paths.sfxDir, "index.json"), JSON.stringify(edited));
    await assembleSfx(paths, { log: () => {} });
    expect((await index()).entries.find((e) => e.id === "door_creak")!.title).toBe("Old oak door");
  });

  describe("refuses an unusable pick and writes nothing", () => {
    const refuse = async (message: RegExp) => {
      const before = await readFile(paths.attribution, "utf8");
      await expect(assembleSfx(paths, { log: () => {} })).rejects.toThrow(AssembleError);
      await expect(assembleSfx(paths, { log: () => {} })).rejects.toThrow(message);
      expect(await readFile(paths.attribution, "utf8")).toBe(before);
      await expect(readFile(join(paths.sfxDir, "index.json"))).rejects.toThrow();
    };

    it("a take changed after it was generated", async () => {
      await writeFile(join(paths.candidatesDir, "rain", "take-1.wav"), door);
      await refuse(/has changed since it was generated/);
    });
    it("a take made from an older prompt", async () => {
      await writeFile(join(paths.sfxDir, "prompts.json"), JSON.stringify({ version: 1, cues: CUES.map((c) => (c.id === "rain" ? { ...c, prompt: "Heavier rain." } : c)) }));
      await refuse(/older prompt, duration or seed/);
    });
    it("a take that was never generated", async () => {
      await writeFile(join(paths.sfxDir, "picks.json"), JSON.stringify({ version: 1, picks: { door_creak: 3 } }));
      await refuse(/take 3 is not in the candidates folder/);
    });
    it("a pick for a cue that does not exist", async () => {
      await writeFile(join(paths.sfxDir, "picks.json"), JSON.stringify({ version: 1, picks: { lightning_bolt: 1 } }));
      await refuse(/not in prompts\.json: lightning_bolt/);
    });
    it("a model whose output licence cannot be bundled", async () => {
      await writeTakes({ model: { ...model, license: "CC-BY-NC-4.0" }, takes: { door_creak: { "2": take(CUES[0]!, 2, door) }, rain: { "1": take(CUES[1]!, 1, rain) } } });
      await refuse(/"CC-BY-NC-4\.0"; only CC0-1\.0, Apache-2\.0, MIT/);
    });
  });

  it("does not replace a curated sound with a generated one of the same id", async () => {
    const curated = { id: "rain", kind: "sfx", title: "Rain", path: "beds/curated_rain.wav", sha256: "c".repeat(64), durationMs: 20_000, loopable: true, peakDb: -1, tags: [], source: { type: "cc0", url: "https://freesound.org/s/2/", licence: "CC0-1.0" } };
    await writeFile(join(paths.sfxDir, "index.json"), JSON.stringify({ version: 1, id: "old", entries: [curated], musicCues: {} }));
    await expect(assembleSfx(paths, { log: () => {} })).rejects.toThrow(/already in the library as a cc0 sound/);
  });
});
