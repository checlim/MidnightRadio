import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { probeAudio, runFfmpeg, type FfmpegOptions } from "./ffmpeg.js";
import { SAMPLE_RATE } from "./timeline.js";
import { ffmetadata, type ChapterMarker } from "./transcript.js";

/**
 * The Vintage AM variant (Task 9.3, Req 6.3) and mastering to MP3 (Task 9.4, Req 6.4).
 *
 * AM is derived from the clean mix, so both variants share one timeline and one length: a
 * 300–3,400 Hz band-limit (two 12 dB/octave stages each side), gentle tanh saturation, and a
 * low crackle bed (sparse velvet-noise clicks and faint hiss, fixed seeds, so it is repeatable).
 *
 * Mastering is two-pass `loudnorm` to −16 LUFS with a −1.5 dBTP ceiling, then 192 kbps MP3 at
 * 44.1 kHz mono (MPEG-2 rates such as 24 kHz top out at 160 kbps), with ID3 tags and chapters. The
 * decoded MP3 is measured; if it misses −16 ±1 LU or exceeds −1.0 dBTP, it is re-mastered with a
 * lower ceiling, at most three times, and then refused rather than shipped.
 */

export const TARGET_LUFS = -16;
export const LUFS_TOLERANCE = 1;
export const MAX_TRUE_PEAK = -1;
export const MP3_RATE = 44_100;
export const MP3_BITRATE = "192k";

export const AM_CHAIN = [
  "highpass=f=300:poles=2",
  "highpass=f=300:poles=2",
  "lowpass=f=3400:poles=2",
  "lowpass=f=3400:poles=2",
  "volume=6dB",
  "asoftclip=type=tanh",
  "volume=-6dB",
].join(",");

/** Crackle: sparse clicks plus faint hiss, band-limited like the broadcast. Levels in dBFS before mastering. */
function crackle(frames: number): string {
  const src = (color: string, seed: number, amp: number) => `anoisesrc=r=${SAMPLE_RATE}:color=${color}:seed=${seed}:amplitude=${amp},atrim=end_sample=${frames}`;
  return `${src("velvet", 1940, 0.05)},highpass=f=1200,volume=-34dB[clicks];${src("pink", 1897, 0.5)},highpass=f=300,lowpass=f=3400,volume=-52dB[hiss];[clicks][hiss]amix=inputs=2:normalize=0[crackle]`;
}

/** Render the AM variant of a clean float stem, sample for sample the same length. */
export async function renderAm(cleanPath: string, amPath: string, opts: FfmpegOptions = {}): Promise<void> {
  const { durationMs } = await probeAudio(cleanPath, opts);
  const frames = Math.round((durationMs * SAMPLE_RATE) / 1000);
  const graph = `[0:a]aformat=sample_fmts=flt:sample_rates=${SAMPLE_RATE}:channel_layouts=mono,${AM_CHAIN}[band];${crackle(frames)};[band][crackle]amix=inputs=2:normalize=0:duration=first,atrim=end_sample=${frames}[out]`;
  await runFfmpeg({ inputs: [{ path: cleanPath }], filter: { type: "complex", graph }, outputOptions: ["-map", "[out]", "-c:a", "pcm_f32le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"], output: amPath }, opts);
}

const LoudnormSchema = z.object({ input_i: z.string(), input_tp: z.string(), input_lra: z.string(), input_thresh: z.string(), target_offset: z.string() });

/** Pass 1: loudnorm's measurement of a file, for the second, linear pass. */
async function measureForLoudnorm(path: string, ceiling: number, opts: FfmpegOptions): Promise<z.infer<typeof LoudnormSchema>> {
  const r = await runFfmpeg({ inputs: [{ path }], filter: { type: "audio", graph: `loudnorm=I=${TARGET_LUFS}:TP=${ceiling}:LRA=11:print_format=json` }, output: null, logLevel: "info" }, opts);
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(r.log);
  if (!json) throw new Error("loudnorm printed no measurement");
  return LoudnormSchema.parse(JSON.parse(json[0]));
}

export interface Loudness {
  integratedLufs: number;
  truePeakDbtp: number;
}

/** Integrated loudness and true peak of a file, as decoded (EBU R128, `ebur128=peak=true`). */
export async function measureLoudness(path: string, opts: FfmpegOptions = {}): Promise<Loudness> {
  const r = await runFfmpeg({ inputs: [{ path }], filter: { type: "audio", graph: "ebur128=peak=true:framelog=quiet" }, output: null, logLevel: "info" }, opts);
  const summary = r.log.slice(r.log.lastIndexOf("Summary:"));
  const i = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary);
  const p = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
  if (!i || !p) throw new Error("ebur128 printed no summary");
  const num = (s: string) => (s === "-inf" ? -Infinity : Number(s));
  return { integratedLufs: num(i[1]!), truePeakDbtp: num(p[1]!) };
}

export interface Mp3Tags {
  title: string;
  /** Series name, e.g. "Midnight Radio". */
  album: string;
  /** Book author (the work's), shown as the artist. */
  artist: string;
  /** Track number: the episode. */
  track: number;
  /** Plain-language disclosure (Req 9.3). */
  aiDisclosure: string;
}

export interface MasterResult extends Loudness {
  /** Mastering passes it took (1–3). */
  passes: number;
  durationMs: number;
}

export class MasteringError extends Error {
  constructor(
    message: string,
    readonly measured: Loudness,
  ) {
    super(message);
    this.name = "MasteringError";
  }
}

export interface MasterTargets {
  lufs: number;
  tolerance: number;
  maxTruePeak: number;
}
export const DEFAULT_TARGETS: MasterTargets = { lufs: TARGET_LUFS, tolerance: LUFS_TOLERANCE, maxTruePeak: MAX_TRUE_PEAK };

/** Whether decoded audio meets the delivery targets (Req 6.4). */
export const meetsTargets = (l: Loudness, t: MasterTargets = DEFAULT_TARGETS): boolean => Math.abs(l.integratedLufs - t.lufs) <= t.tolerance && l.truePeakDbtp <= t.maxTruePeak;

/** Master a float stem to a tagged 192 kbps MP3 with chapters, and check the decoded result. */
export async function masterToMp3(
  stemPath: string,
  mp3Path: string,
  meta: { tags: Mp3Tags; chapters: ChapterMarker[]; workDir: string; /** Delivery targets; the defaults are the requirement. */ targets?: MasterTargets },
  opts: FfmpegOptions = {},
): Promise<MasterResult> {
  const targets = meta.targets ?? DEFAULT_TARGETS;
  const dir = join(meta.workDir, `master-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  try {
    const metaPath = join(dir, "meta.txt");
    const tags = {
      title: meta.tags.title,
      album: meta.tags.album,
      artist: meta.tags.artist,
      track: String(meta.tags.track),
      genre: "Radio drama",
      comment: meta.tags.aiDisclosure,
      // A machine-readable flag as an ID3 TXXX frame, alongside the plain-language comment.
      AI_GENERATED: "yes",
    };
    await writeFile(metaPath, ffmetadata(tags, meta.chapters));
    let ceiling = -1.5;
    let last: Loudness | undefined;
    for (let pass = 1; pass <= 3; pass++) {
      const m = await measureForLoudnorm(stemPath, ceiling, opts);
      const normalise = `loudnorm=I=${TARGET_LUFS}:TP=${ceiling}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=${MP3_RATE}:filter_size=64:cutoff=0.97`;
      await runFfmpeg(
        {
          inputs: [{ path: stemPath }, { path: metaPath, options: ["-f", "ffmetadata"] }],
          filter: { type: "audio", graph: normalise },
          outputOptions: ["-map", "0:a", "-map_metadata", "1", "-map_chapters", "1", "-ac", "1", "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-id3v2_version", "3", "-write_xing", "1"],
          output: mp3Path,
        },
        opts,
      );
      last = await measureLoudness(mp3Path, opts);
      if (meetsTargets(last, targets)) {
        const { durationMs } = await probeAudio(mp3Path, opts);
        return { ...last, passes: pass, durationMs };
      }
      ceiling -= 1; // MP3 encoding can raise inter-sample peaks; leave more room
    }
    throw new MasteringError(`the episode could not be mastered to ${targets.lufs} LUFS ±${targets.tolerance} with true peak ≤ ${targets.maxTruePeak} dBTP (got ${last!.integratedLufs} LUFS, ${last!.truePeakDbtp} dBTP)`, last!);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
