import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@midnight-radio/core";
import { duckingEnvelope, encodeFloatWav, type DuckingOptions } from "./envelope.js";
import { runFfmpeg, type FfmpegInput, type FfmpegOptions } from "./ffmpeg.js";
import { SAMPLE_RATE, speechRanges, type Timeline } from "./timeline.js";

/**
 * Render a timeline to one 24 kHz mono 32-bit float WAV (Tasks 9.1, 9.2). Float keeps headroom
 * until mastering (Task 9.4) sets the final level; it never leaves the mix pipeline.
 *
 * Speech, cues and pauses never overlap, so they are concatenated in order with generated
 * silence for the gaps: every item is converted, trimmed (or padded) to its exact frame count and
 * looped where the timeline says so, which keeps the result sample-exact over a whole episode.
 * Each scene's bed is looped and trimmed to the scene, set to its gain, multiplied by its ducking
 * envelope, delayed to the scene's first sample and mixed in.
 */

export interface BedAudio {
  path: string;
  /** Frames of the bed file at 24 kHz, for looping. */
  frames: number;
}

export interface RenderOptions extends FfmpegOptions {
  /** The file for each scene's ambience id (`assets/sfx/<path>`). */
  beds: (id: string) => BedAudio;
  /** Folder for the generated envelope files; removed afterwards. */
  workDir: string;
  /** `full` (default), or one stem on its own for measurement. */
  stem?: "full" | "beds" | "dry";
  ducking?: DuckingOptions;
}

const FORMAT = `aformat=sample_fmts=flt:sample_rates=${SAMPLE_RATE}:channel_layouts=mono`;

/** The filter graph and inputs for a timeline. Exported for tests and for logging. */
export function mixGraph(timeline: Timeline, opts: Pick<RenderOptions, "beds" | "stem">, envelopePath: (sceneIdx: number) => string): { inputs: FfmpegInput[]; graph: string } {
  const stem = opts.stem ?? "full";
  const inputs: FfmpegInput[] = [];
  const index = new Map<string, number>();
  const input = (path: string) => {
    let i = index.get(path);
    if (i === undefined) {
      i = inputs.length;
      inputs.push({ path });
      index.set(path, i);
    }
    return i;
  };
  const chains: string[] = [];
  const total = timeline.totalFrames;

  // Dry track: items and gaps, concatenated.
  const parts: string[] = [];
  let cursor = 0;
  let n = 0;
  const silence = (frames: number) => {
    const label = `g${n++}`;
    chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=end_sample=${frames},${FORMAT}[${label}]`);
    parts.push(`[${label}]`);
  };
  for (const it of timeline.items) {
    if (it.startFrame > cursor) silence(it.startFrame - cursor);
    if (it.kind === "pause" || stem === "beds") {
      silence(it.frames);
    } else {
      const label = `i${n++}`;
      const loop = it.kind !== "speech" && it.loop ? `,aloop=loop=-1:size=${it.fileFrames}` : "";
      chains.push(`[${input(it.file)}:a]${FORMAT}${loop},apad=whole_len=${it.frames},atrim=end_sample=${it.frames},asetpts=N/SR/TB[${label}]`);
      parts.push(`[${label}]`);
    }
    cursor = it.startFrame + it.frames;
  }
  if (cursor < total) silence(total - cursor);
  if (parts.length === 0) silence(Math.max(1, total));
  chains.push(`${parts.join("")}concat=n=${parts.length}:v=0:a=1[dry]`);

  // Beds.
  const beds: string[] = [];
  if (stem !== "dry") {
    for (const scene of timeline.scenes) {
      if (!scene.ambience) continue;
      const length = scene.endFrame - scene.startFrame;
      if (length <= 0) continue;
      const bed = opts.beds(scene.ambience.id);
      const gain = scene.ambience.gainDb ?? LIMITS.defaultBedGainDb;
      const b = `b${scene.sceneIdx}`;
      chains.push(`[${input(bed.path)}:a]${FORMAT},aloop=loop=-1:size=${Math.max(1, bed.frames)},atrim=end_sample=${length},asetpts=N/SR/TB,volume=${gain}dB[${b}raw]`);
      chains.push(`[${input(envelopePath(scene.sceneIdx))}:a]${FORMAT},atrim=end_sample=${length}[${b}env]`);
      chains.push(`[${b}raw][${b}env]amultiply,adelay=delays=${scene.startFrame}S:all=1,apad=whole_len=${total},atrim=end_sample=${total}[${b}]`);
      beds.push(`[${b}]`);
    }
  }
  if (beds.length === 0) chains.push(`[dry]anull[out]`);
  // Every input is exactly `total` frames, so `longest` equals `first`; FFmpeg 4.4's amix with
  // `duration=first` ends early (seconds short) when a delayed bed lags behind the dry track.
  else chains.push(`[dry]${beds.join("")}amix=inputs=${beds.length + 1}:normalize=0:duration=longest:dropout_transition=0,atrim=end_sample=${total}[out]`);
  return { inputs, graph: chains.join(";") };
}

/** Render the timeline to `outPath` (float WAV). Writes and then removes one envelope file per bedded scene. */
export async function renderMix(timeline: Timeline, outPath: string, opts: RenderOptions): Promise<void> {
  const dir = join(opts.workDir, `env-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  try {
    const ranges = speechRanges(timeline);
    const envPath = (sceneIdx: number) => join(dir, `scene-${sceneIdx}.wav`);
    for (const scene of timeline.scenes) {
      if (!scene.ambience || scene.endFrame <= scene.startFrame) continue;
      await writeFile(envPath(scene.sceneIdx), encodeFloatWav(duckingEnvelope(scene.startFrame, scene.endFrame, ranges, opts.ducking)));
    }
    const { inputs, graph } = mixGraph(timeline, opts, envPath);
    await runFfmpeg({ inputs, filter: { type: "complex", graph }, outputOptions: ["-map", "[out]", "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_f32le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"], output: outPath }, opts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
