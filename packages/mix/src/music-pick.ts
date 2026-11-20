import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { MUSIC_CUES } from "@midnight-radio/core";
import { z } from "zod";
import { readPcm16 } from "./autopick.js";
import { runFfmpeg, type FfmpegOptions } from "./ffmpeg.js";

/**
 * Choosing the theme, sting and transition excerpts without a listener.
 *
 * Which file may serve which cue is decided once in `assets/sfx/music-sources.json`, by what the
 * piece is (level analysis cannot tell a theme from a held organ chord). Within those files the
 * excerpt is chosen by measurement: each file is decoded to 24 kHz mono and cut into 100 ms
 * windows, every start point (0.1 s steps) is judged, and the best excerpt wins. The record of
 * every file, its best excerpt and why it lost goes to `assets/sfx/music-picks.json`.
 *
 * An excerpt is out if it has a gap (a window more than 30 dB below the file's loudest window, or
 * below −50 dBFS) or a cut (the level falls by more than 18 dB from one window to the next)
 * before its fade-out starts; inside the fade-out (which hides them) a reverb tail or a dry stop
 * is fine, and the level measures below are taken before the fade too. The rest score 100 + 2 × (mean level relative to the file's loudest window) − 2 × level spread
 * − a start penalty: for the theme and transition, the dB the first window sits below the
 * excerpt's median; for the sting, 3 × the dB its first 200 ms sit below the excerpt's loudest
 * window (a sting must hit at once). Ties go to the earlier file in the list, then the earlier start.
 */

export const MUSIC_PICK_VERSION = "musicpick-1";

export type MusicCue = (typeof MUSIC_CUES)[number];

/** Target and shortest acceptable excerpt length (s) and fade-out (s) per cue. */
export const MUSIC_TARGETS: Record<MusicCue, { targetS: number; minS: number; fadeOutS: number }> = {
  theme: { targetS: 20, minS: 12, fadeOutS: 2 },
  transition: { targetS: 5, minS: 3, fadeOutS: 1 },
  sting: { targetS: 2, minS: 1.2, fadeOutS: 0.5 },
};
const WINDOW_S = 0.1;
const GAP_BELOW_LOUDEST_DB = 30;
const GAP_FLOOR_DB = -50;
const CUT_DROP_DB = 18;

export interface ExcerptVerdict {
  startS: number;
  durationS: number;
  meanRelDb: number;
  spreadDb: number;
  startPenaltyDb: number;
  rejected: string | null;
  score: number | null;
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** Levels (dBFS) of consecutive 100 ms windows. Pure. Silence is −120 dB rather than −∞. */
export function windowLevels(samples: Int16Array, rate: number): number[] {
  const n = Math.max(1, Math.round(rate * WINDOW_S));
  const out: number[] = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let sum = 0;
    for (let j = i; j < i + n; j++) sum += (samples[j]! / 32768) ** 2;
    out.push(Math.max(-120, 10 * Math.log10(sum / n || 1e-12)));
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Judge the excerpt of `count` windows starting at window `start`. Pure. */
export function judgeExcerpt(levels: readonly number[], start: number, count: number, cue: MusicCue): ExcerptVerdict {
  const fadeWindows = Math.round(MUSIC_TARGETS[cue].fadeOutS / WINDOW_S);
  const w = levels.slice(start, start + Math.max(1, count - fadeWindows));
  const loudest = Math.max(...levels);
  const mean = w.reduce((a, b) => a + b, 0) / w.length;
  const spread = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length);
  const startPenalty = cue === "sting" ? Math.max(0, Math.max(...w) - Math.max(...w.slice(0, 2))) : Math.max(0, median(w) - w[0]!);
  const v = { startS: round(start * WINDOW_S, 1), durationS: round(count * WINDOW_S, 1), meanRelDb: round(mean - loudest), spreadDb: round(spread), startPenaltyDb: round(startPenalty) };
  const gap = w.findIndex((d) => d < loudest - GAP_BELOW_LOUDEST_DB || d < GAP_FLOOR_DB);
  if (gap !== -1) return { ...v, rejected: `gap at ${round((start + gap) * WINDOW_S, 1)} s`, score: null };
  const cut = w.findIndex((d, i) => i > 0 && w[i - 1]! - d > CUT_DROP_DB);
  if (cut !== -1) return { ...v, rejected: `cut at ${round((start + cut) * WINDOW_S, 1)} s`, score: null };
  const score = 100 + 2 * (mean - loudest) - 2 * spread - (cue === "sting" ? 3 : 1) * startPenalty;
  return { ...v, rejected: null, score: round(score) };
}

/** The best excerpt of a file for a cue (earliest start on a tie), or the reason none fits. Pure. */
export function bestExcerpt(levels: readonly number[], cue: MusicCue): ExcerptVerdict | { rejected: string; score: null } {
  const { targetS, minS } = MUSIC_TARGETS[cue];
  const count = Math.min(Math.round(targetS / WINDOW_S), levels.length);
  if (count === 0 || count * WINDOW_S < minS - 1e-9) return { rejected: `${round(levels.length * WINDOW_S, 1)} s long, shorter than ${minS} s`, score: null };
  let best: ExcerptVerdict | null = null;
  let firstReject: ExcerptVerdict | null = null;
  for (let start = 0; start + count <= levels.length; start++) {
    const v = judgeExcerpt(levels, start, count, cue);
    if (v.score === null) firstReject ??= v;
    else if (best === null || v.score > best.score!) best = v;
  }
  return best ?? { rejected: `every excerpt has a gap or a cut (first: ${firstReject!.rejected})`, score: null };
}

export const MusicSourcesSchema = z.object({
  version: z.literal(1),
  items: z
    .array(
      z
        .object({
          file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
          title: z.string().min(1).max(120),
          sourcePage: z.url().startsWith("https://"),
          author: z.string().min(1).max(200),
          licence: z.literal("CC0-1.0"),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          cues: z.array(z.enum(MUSIC_CUES)).min(1),
        })
        .passthrough(),
    )
    .min(1),
});
export type MusicSource = z.infer<typeof MusicSourcesSchema>["items"][number];

export interface MusicChoice {
  cue: MusicCue;
  /** The library id the excerpt is imported under. */
  id: string;
  source: MusicSource;
  startS: number;
  durationS: number;
  fadeOutS: number;
  score: number;
}

export interface MusicPickReport {
  version: string;
  cues: {
    cue: MusicCue;
    picked: { file: string; startS: number; durationS: number; score: number } | null;
    candidates: { file: string; rejected: string | null; best: ExcerptVerdict | null }[];
  }[];
}

/** Library id for a cue's excerpt of a file, e.g. `theme_lisboa_horror_overture`. */
export const musicIdFor = (cue: MusicCue, file: string) =>
  `${cue}_${basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`.slice(0, 48).replace(/_+$/, "");

export interface AnalysedSource {
  source: MusicSource;
  /** 100 ms window levels, or null when the file could not be used. */
  levels: number[] | null;
  problem: string | null;
}

/** Choose one excerpt per cue among the files allowed to serve it. Pure. */
export function chooseMusic(analysed: readonly AnalysedSource[]): { choices: MusicChoice[]; report: MusicPickReport } {
  const choices: MusicChoice[] = [];
  const report: MusicPickReport = { version: MUSIC_PICK_VERSION, cues: [] };
  for (const cue of MUSIC_CUES) {
    const candidates: MusicPickReport["cues"][number]["candidates"] = [];
    let win: { source: MusicSource; v: ExcerptVerdict } | null = null;
    for (const { source, levels, problem } of analysed) {
      if (!source.cues.includes(cue)) continue;
      if (problem !== null || levels === null) {
        candidates.push({ file: source.file, rejected: problem ?? "not analysed", best: null });
        continue;
      }
      const v = bestExcerpt(levels, cue);
      if (v.score === null) {
        candidates.push({ file: source.file, rejected: v.rejected, best: null });
        continue;
      }
      const verdict = v as ExcerptVerdict;
      candidates.push({ file: source.file, rejected: null, best: verdict });
      if (win === null || verdict.score! > win.v.score!) win = { source, v: verdict };
    }
    if (win) choices.push({ cue, id: musicIdFor(cue, win.source.file), source: win.source, startS: win.v.startS, durationS: win.v.durationS, fadeOutS: MUSIC_TARGETS[cue].fadeOutS, score: win.v.score! });
    report.cues.push({ cue, picked: win ? { file: win.source.file, startS: win.v.startS, durationS: win.v.durationS, score: win.v.score! } : null, candidates });
  }
  return { choices, report };
}

/**
 * Read the source list, check each file against its recorded hash (the file whose CC0 licence was
 * checked), decode it to 24 kHz mono and choose the excerpts. A missing, changed or undecodable
 * file is recorded and never used.
 */
export async function pickMusic(sourcesPath: string, candidatesDir: string, ff: FfmpegOptions = {}): Promise<{ choices: MusicChoice[]; report: MusicPickReport }> {
  const sources = MusicSourcesSchema.parse(JSON.parse(await readFile(sourcesPath, "utf8")));
  const tmp = await mkdtemp(join(tmpdir(), "mr-music-"));
  try {
    const analysed: AnalysedSource[] = [];
    for (const source of sources.items) {
      const path = join(candidatesDir, source.file);
      const bytes = await readFile(path).catch(() => null);
      if (bytes === null) {
        analysed.push({ source, levels: null, problem: `missing from ${candidatesDir}` });
        continue;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
        analysed.push({ source, levels: null, problem: "differs from the file whose licence was checked (sha256 mismatch)" });
        continue;
      }
      const out = join(tmp, `${randomBytes(6).toString("hex")}.wav`);
      try {
        await runFfmpeg({ inputs: [{ path }], outputOptions: ["-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"], output: out }, { log: () => {}, ...ff });
        const { samples, rate } = readPcm16(new Uint8Array(await readFile(out)));
        analysed.push({ source, levels: windowLevels(samples, rate), problem: null });
      } catch (err) {
        analysed.push({ source, levels: null, problem: `cannot decode (${(err as Error).message.split("\n")[0]})` });
      }
    }
    return chooseMusic(analysed);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
