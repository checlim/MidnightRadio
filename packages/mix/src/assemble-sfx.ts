import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SFX_LICENCES, SfxCatalogueSchema, type SfxCatalogue, type SfxEntry, type SfxLicence } from "@midnight-radio/core";
import { validateWav } from "@midnight-radio/tts";
import { z } from "zod";
import { runFfmpeg, type FfmpegOptions } from "./ffmpeg.js";

/**
 * Turn the chosen foley takes into the sound library (Task 6.1).
 *
 * Inputs: `assets/sfx/prompts.json` (the cues), the candidates folder written by
 * `services/local-audio/tools/generate_sfx.py` (`takes.json` and the takes, kept there as the
 * 48 kHz masters), and `assets/sfx/picks.json` (which take of each cue to use).
 * For every pick: check the take is the one recorded for the current prompt and seed, convert it
 * to the 24 kHz mono 16-bit working format, make beds loop seamlessly (the tail is crossfaded
 * into the head), give discrete sounds tiny edge fades, normalise the peak to -1 dBFS, and check
 * the result. Then write `assets/sfx/index.json` (other entries, such as CC0 sounds and music, are
 * kept) and the sound section of `ATTRIBUTION.md`. Running it twice gives identical files.
 */

export const TARGET_PEAK_DB = -1;
export const WORKING_RATE = 24_000;
const FADE_IN_S = 0.005;
const FADE_OUT_S = 0.03;
/** Resampling: ffmpeg's own resampler at high quality (this ffmpeg has no soxr). */
const RESAMPLE = `aresample=${WORKING_RATE}:filter_size=64:cutoff=0.97,aformat=sample_fmts=flt:channel_layouts=mono`;
const BITEXACT = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"];

const cueId = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);

const PromptsSchema = z.object({
  version: z.literal(1),
  cues: z.array(z.object({ id: cueId, prompt: z.string().min(1).max(500), durationSec: z.number().min(0.5).max(30), seed: z.number().int().min(0), loopable: z.boolean(), tags: z.array(z.string()).max(8).optional() })).min(1),
});
export type Cue = z.infer<typeof PromptsSchema>["cues"][number];

/** `takes.json` from the generation tool. Untrusted: it is checked before use and every take's hash is re-verified. */
const TakesSchema = z.object({
  model: z.object({ model: z.string().min(1).max(100), revision: z.string().min(1).max(100), weightsSha256: sha.nullable(), license: z.string().min(1).max(100), sampleRate: z.number().int() }),
  takes: z.record(cueId, z.record(z.string().regex(/^\d+$/), z.object({ prompt: z.string(), durationSec: z.number(), seed: z.number().int(), file: z.string().regex(/^take-\d+\.wav$/), sha256: sha, at: z.string() }))),
});

export const PicksSchema = z.strictObject({
  version: z.literal(1),
  /** Take number per cue id; null (or absent) leaves that cue out for now. */
  picks: z.record(cueId, z.number().int().min(1).max(10).nullable()),
});

export class AssembleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssembleError";
  }
}

export interface AssemblePaths {
  /** `assets/sfx`: prompts.json, picks.json, index.json and the output files live here. */
  sfxDir: string;
  /** The generation tool's output folder. */
  candidatesDir: string;
  /** `ATTRIBUTION.md`. */
  attribution: string;
}

export interface AssembledSound {
  id: string;
  path: string;
  durationMs: number;
  /** Sudden jumps worth a listen (seconds into the file). Natural transients can show up here too. */
  possibleClicks: number[];
}

export interface AssembleReport {
  catalogueId: string;
  assembled: AssembledSound[];
  /** Cues with no pick yet. */
  skipped: string[];
}

const readJson = async (path: string, what: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new AssembleError(`cannot read ${what} (${path}): ${(err as NodeJS.ErrnoException).code ?? "not valid JSON"}`);
  }
};
const parse = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw new AssembleError(`${what} is not valid: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`);
  return r.data;
};
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** "door_creak" → "Door creak". */
export const titleFor = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, " ");

/** Length of the crossfade that closes a bed's loop: a tenth of the take, between 0.5 and 2 seconds. */
export const loopCrossfadeS = (durationS: number) => Math.min(2, Math.max(0.5, durationS / 10));

/** The filter graph for one take, up to (not including) the gain. Output label `[shaped]`. */
export function shapeGraph(cue: Cue): string {
  if (!cue.loopable) {
    const outStart = (cue.durationSec - FADE_OUT_S).toFixed(3);
    return `[0:a]${RESAMPLE},afade=t=in:d=${FADE_IN_S},afade=t=out:st=${outStart}:d=${FADE_OUT_S}[shaped]`;
  }
  const f = loopCrossfadeS(cue.durationSec).toFixed(3);
  // body = take[f:], head = take[:f]; crossfading body's end into head makes the last sample
  // continue into the first, so the bed loops without a seam.
  return `[0:a]${RESAMPLE},asplit=2[a][b];[a]atrim=end=${f},asetpts=PTS-STARTPTS[head];[b]atrim=start=${f},asetpts=PTS-STARTPTS[body];[body][head]acrossfade=d=${f}:c1=qsin:c2=qsin[shaped]`;
}

/** 16-bit samples of a validated mono WAV. */
function samplesOf(bytes: Uint8Array): Int16Array {
  const info = validateWav(bytes, { sampleRate: WORKING_RATE, channels: 1, bitsPerSample: 16, maxDurationMs: 300_000 });
  const copy = bytes.slice(info.dataOffset, info.dataOffset + info.dataLength);
  return new Int16Array(copy.buffer, copy.byteOffset, info.frames);
}

/**
 * Positions (seconds) of sudden sample-to-sample jumps far larger than the sound's own movement:
 * above both a third of full scale and 6× the 99.9th percentile jump. At most 10, at least 50 ms apart.
 */
export function findClicks(samples: Int16Array, rate: number): number[] {
  if (samples.length < 3) return [];
  const jumps = new Float64Array(samples.length - 1);
  for (let i = 1; i < samples.length; i++) jumps[i - 1] = Math.abs(samples[i]! - samples[i - 1]!);
  const sorted = Float64Array.from(jumps).sort();
  const p999 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.999))]!;
  const threshold = Math.max(32768 / 3, 6 * p999);
  const found: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < jumps.length && found.length < 10; i++) {
    if (jumps[i]! > threshold && i - last > rate * 0.05) {
      found.push(Math.round(((i + 1) / rate) * 1000) / 1000);
      last = i;
    }
  }
  return found;
}

/** How far the loop point jumps compared with the bed's own largest sample-to-sample movement (≤ 1 is seamless). */
export function loopSeamRatio(samples: Int16Array): number {
  let maxJump = 1;
  for (let i = 1; i < samples.length; i++) maxJump = Math.max(maxJump, Math.abs(samples[i]! - samples[i - 1]!));
  return Math.abs(samples[0]! - samples[samples.length - 1]!) / maxJump;
}

const peakDbOf = (samples: Int16Array) => {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  return peak === 0 ? -Infinity : 20 * Math.log10(peak / 32768);
};

async function processTake(cue: Cue, takePath: string, outPath: string, ff: FfmpegOptions): Promise<{ bytes: Uint8Array; samples: Int16Array }> {
  const graph = shapeGraph(cue);
  // Pass 1: measure the shaped signal's peak (in float, before any rounding).
  const measured = await runFfmpeg({ inputs: [{ path: takePath }], filter: { type: "complex", graph: `${graph};[shaped]astats=metadata=0:measure_overall=Peak_level:measure_perchannel=none[m]` }, outputOptions: ["-map", "[m]"], output: null, logLevel: "info" }, ff);
  const match = /Peak level dB:\s*(-?[\d.]+|-inf)/.exec(measured.log);
  if (!match || match[1] === "-inf") throw new AssembleError(`${cue.id}: the take is silent after conversion`);
  const gainDb = (TARGET_PEAK_DB - Number(match[1])).toFixed(4);
  // Pass 2: the same chain plus the gain, written as 24 kHz mono 16-bit with a stable header.
  const tmp = join(dirname(outPath), `.${cue.id}.${randomBytes(6).toString("hex")}.wav`);
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await runFfmpeg({ inputs: [{ path: takePath }], filter: { type: "complex", graph: `${graph};[shaped]volume=${gainDb}dB[out]` }, outputOptions: ["-map", "[out]", "-ac", "1", "-c:a", "pcm_s16le", ...BITEXACT], output: tmp }, ff);
    const bytes = new Uint8Array(await readFile(tmp));
    return { bytes, samples: samplesOf(bytes) };
  } finally {
    await rm(tmp, { force: true });
  }
}

function checkResult(cue: Cue, samples: Int16Array): void {
  const durationS = samples.length / WORKING_RATE;
  const expected = cue.loopable ? cue.durationSec - loopCrossfadeS(cue.durationSec) : cue.durationSec;
  if (Math.abs(durationS - expected) > 0.05) throw new AssembleError(`${cue.id}: the result is ${durationS.toFixed(3)} s, expected ${expected.toFixed(3)} s`);
  const peak = peakDbOf(samples);
  if (!(Math.abs(peak - TARGET_PEAK_DB) <= 0.3)) throw new AssembleError(`${cue.id}: the peak is ${peak.toFixed(2)} dBFS, expected ${TARGET_PEAK_DB} dBFS`);
  if (cue.loopable) {
    const ratio = loopSeamRatio(samples);
    if (ratio > 1) throw new AssembleError(`${cue.id}: the loop point jumps ${ratio.toFixed(2)}× more than anything in the bed; it would click when looped`);
  } else {
    const edge = 0.01 * 32768;
    if (Math.abs(samples[0]!) > edge || Math.abs(samples[samples.length - 1]!) > edge) throw new AssembleError(`${cue.id}: the sound starts or ends abruptly (a click)`);
  }
}

/** A catalogue id that changes whenever any entry changes. */
export function catalogueIdFor(entries: SfxEntry[], musicCues: SfxCatalogue["musicCues"]): string {
  const canonical = JSON.stringify({ entries: [...entries].sort((a, b) => (a.id < b.id ? -1 : 1)), musicCues });
  return `midnight-radio-sfx-${sha256(new TextEncoder().encode(canonical)).slice(0, 12)}`;
}

const BEGIN = "<!-- sfx-library:begin (generated by packages/mix/scripts/assemble-sfx.ts; edit index.json, not this block) -->";
const END = "<!-- sfx-library:end -->";

/** The sound section of ATTRIBUTION.md for a catalogue. Pure. */
export function attributionBlock(catalogue: SfxCatalogue): string {
  const rows = [...catalogue.entries].sort((a, b) => (a.id < b.id ? -1 : 1));
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [BEGIN, ""];
  if (rows.length === 0) lines.push("No sounds are bundled yet.");
  else {
    const models = new Map<string, { licence: string; weights?: string; count: number }>();
    for (const e of rows) {
      if (e.source.type !== "generated") continue;
      const key = `${e.source.model} (revision \`${e.source.revision}\`)`;
      const m = models.get(key) ?? { licence: e.source.licence, ...(e.source.weightsSha256 ? { weights: e.source.weightsSha256 } : {}), count: 0 };
      m.count++;
      models.set(key, m);
    }
    for (const [model, m] of models) {
      lines.push(`- **Generated:** ${m.count} sound${m.count === 1 ? "" : "s"} made offline for this project with ${cell(model)} through the [sound-effect service API](docs/sfx-service-api.md); model output licence as reported by the service: ${m.licence}.${m.weights ? ` Weights SHA-256 \`${m.weights}\`.` : ""} Each file's prompt and seed are in \`assets/sfx/index.json\`.`);
    }
    lines.push("", "| Sound | File | Source | Licence |", "|---|---|---|---|");
    for (const e of rows) {
      const s = e.source;
      const source = s.type === "generated" ? `generated, seed ${s.seed}` : s.type === "cc0" ? `<${s.url}>${s.author ? ` by ${cell(s.author)}` : ""}` : `made for the project by ${cell(s.author)}`;
      lines.push(`| ${cell(e.title)} (\`${e.id}\`) | \`assets/sfx/${e.path}\` | ${source} | ${s.licence} |`);
    }
  }
  lines.push("", END);
  return lines.join("\n");
}

/** Replace the generated block (or the placeholder paragraph) in the "Sound effects and music" section. */
export function updateAttribution(markdown: string, block: string): string {
  const begin = markdown.indexOf("<!-- sfx-library:begin");
  const end = markdown.indexOf(END);
  if (begin !== -1 && end > begin) return markdown.slice(0, begin) + block + markdown.slice(end + END.length);
  const heading = markdown.indexOf("## Sound effects and music");
  if (heading === -1) throw new AssembleError('ATTRIBUTION.md has no "## Sound effects and music" section');
  const bodyStart = markdown.indexOf("\n", heading) + 1;
  const next = markdown.indexOf("\n## ", bodyStart);
  const bodyEnd = next === -1 ? markdown.length : next + 1;
  return `${markdown.slice(0, bodyStart)}\n${block}\n${markdown.slice(bodyEnd)}`;
}

/** Run the whole step. Throws AssembleError (nothing is written to index.json or ATTRIBUTION.md) if any pick is unusable. */
export async function assembleSfx(paths: AssemblePaths, ff: FfmpegOptions = {}): Promise<AssembleReport> {
  const prompts = parse(PromptsSchema, await readJson(join(paths.sfxDir, "prompts.json"), "prompts.json"), "prompts.json");
  const picks = parse(PicksSchema, await readJson(join(paths.sfxDir, "picks.json"), "picks.json"), "picks.json");
  const takes = parse(TakesSchema, await readJson(join(paths.candidatesDir, "takes.json"), "the candidates' takes.json"), "takes.json");
  const indexPath = join(paths.sfxDir, "index.json");
  const existing: SfxCatalogue = existsSync(indexPath) ? parse(SfxCatalogueSchema, await readJson(indexPath, "index.json"), "index.json") : { version: 1, id: "midnight-radio-sfx-empty", entries: [], musicCues: {} };

  const cues = new Map(prompts.cues.map((c) => [c.id, c]));
  const unknown = Object.keys(picks.picks).filter((id) => !cues.has(id));
  if (unknown.length > 0) throw new AssembleError(`picks.json names cues that are not in prompts.json: ${unknown.join(", ")}`);
  const licence = takes.model.license;
  if (!(SFX_LICENCES as readonly string[]).includes(licence)) {
    throw new AssembleError(`the takes were made by ${takes.model.model}, whose output licence is reported as "${licence}"; only ${SFX_LICENCES.join(", ")} can be bundled`);
  }

  const chosen = prompts.cues.filter((c) => picks.picks[c.id] != null);
  const byId = new Map(existing.entries.map((e) => [e.id, e]));
  for (const cue of chosen) {
    const old = byId.get(cue.id);
    if (old && old.source.type !== "generated") throw new AssembleError(`${cue.id} is already in the library as a ${old.source.type} sound; rename the cue rather than replace it`);
  }

  // Check every pick before converting anything, so a bad pick costs no work.
  const work = chosen.map((cue) => {
    const n = String(picks.picks[cue.id]);
    const take = takes.takes[cue.id]?.[n];
    if (!take) throw new AssembleError(`${cue.id}: take ${n} is not in the candidates folder; generate it first`);
    if (take.prompt !== cue.prompt || take.durationSec !== cue.durationSec || take.seed !== cue.seed + Number(n) - 1) {
      throw new AssembleError(`${cue.id}: take ${n} was made from an older prompt, duration or seed; regenerate it or pick again`);
    }
    return { cue, take, takePath: join(paths.candidatesDir, cue.id, take.file) };
  });
  for (const w of work) {
    const bytes = await readFile(w.takePath).catch(() => {
      throw new AssembleError(`${w.cue.id}: ${w.takePath} is missing`);
    });
    if (sha256(bytes) !== w.take.sha256) throw new AssembleError(`${w.cue.id}: ${w.takePath} has changed since it was generated (hash mismatch)`);
  }

  const assembled: AssembledSound[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  const entries = new Map(byId);
  for (const { cue, take, takePath } of work) {
    const rel = `${cue.loopable ? "beds" : "foley"}/${cue.id}.wav`;
    const out = join(paths.sfxDir, rel);
    const { bytes, samples } = await processTake(cue, takePath, out, ff);
    checkResult(cue, samples);
    files.push({ path: out, bytes });
    const durationMs = Math.round((samples.length / WORKING_RATE) * 1000);
    entries.set(cue.id, {
      id: cue.id,
      kind: "sfx",
      title: byId.get(cue.id)?.title ?? titleFor(cue.id),
      path: rel,
      sha256: sha256(bytes),
      durationMs,
      loopable: cue.loopable,
      peakDb: Math.round(peakDbOf(samples) * 100) / 100,
      tags: cue.tags ?? [],
      source: {
        type: "generated",
        model: takes.model.model,
        revision: takes.model.revision,
        ...(takes.model.weightsSha256 ? { weightsSha256: takes.model.weightsSha256 } : {}),
        licence: licence as SfxLicence,
        prompt: cue.prompt,
        seed: take.seed,
        originalSha256: take.sha256,
        generatedAt: take.at,
      },
    });
    assembled.push({ id: cue.id, path: rel, durationMs, possibleClicks: findClicks(samples, WORKING_RATE) });
  }

  const sorted = [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const catalogue = parse(SfxCatalogueSchema, { version: 1, id: catalogueIdFor(sorted, existing.musicCues), entries: sorted, musicCues: existing.musicCues }, "the new index.json");
  const attribution = updateAttribution(await readFile(paths.attribution, "utf8"), attributionBlock(catalogue));

  for (const f of files) await writeAtomic(f.path, f.bytes);
  await writeAtomic(indexPath, `${JSON.stringify(catalogue, null, 2)}\n`);
  await writeAtomic(paths.attribution, attribution);
  return { catalogueId: catalogue.id, assembled, skipped: prompts.cues.filter((c) => picks.picks[c.id] == null).map((c) => c.id) };
}
