import { readFile } from "node:fs/promises";
import { indexSfx, type SfxCatalogue } from "@midnight-radio/core";
import { probeAudio, runFfmpeg, type FfmpegOptions } from "./ffmpeg.js";
import { DEFAULT_TARGETS, measureLoudness, meetsTargets, type MasterTargets } from "./master.js";
import type { Timeline } from "./timeline.js";

/**
 * The checks an episode passes before it is published, and the record of what sounds it
 * actually contains. Publication is decided from the files themselves: every file decodes from
 * start to end without an error, both MP3s last as long as the timeline, both meet the loudness
 * and true-peak targets, and the transcript has a cue for every spoken line. A cue counts as in
 * the episode only if it is on the timeline the mix was rendered from.
 */

export class EpisodeVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpisodeVerificationError";
  }
}

/** How far an MP3's length may be from its timeline (encoder padding and frame rounding). */
export const DURATION_TOLERANCE_MS = 150;

export interface VerifiedFile {
  durationMs: number;
  integratedLufs: number;
  truePeakDbtp: number;
}

export interface EpisodeVerification {
  clean: VerifiedFile;
  am: VerifiedFile;
  transcriptCues: number;
}

/** Decode the whole file; any decoder message is a failure. */
async function decodes(path: string, opts: FfmpegOptions): Promise<void> {
  const r = await runFfmpeg({ inputs: [{ path }], outputOptions: ["-map", "0:a"], output: null, logLevel: "error" }, opts);
  if (r.log.trim() !== "") throw new EpisodeVerificationError(`${path} does not decode cleanly: ${r.log.trim().split("\n")[0]!.slice(0, 200)}`);
}

/** The length of the audio that actually decodes (a header can claim more than the file holds). */
async function decodedMs(path: string, opts: FfmpegOptions): Promise<number> {
  const { sampleRate } = await probeAudio(path, opts);
  const r = await runFfmpeg({ inputs: [{ path }], filter: { type: "audio", graph: "astats=metadata=0:measure_perchannel=none:measure_overall=Number_of_samples" }, output: null, logLevel: "info" }, opts);
  const m = /Number of samples:\s*(\d+)/.exec(r.log);
  if (!m) throw new EpisodeVerificationError(`${path}: could not count its decoded samples`);
  return Math.round((Number(m[1]) / sampleRate) * 1000);
}

async function verifyMp3(path: string, expectedMs: number, targets: MasterTargets, opts: FfmpegOptions): Promise<VerifiedFile> {
  await decodes(path, opts);
  const durationMs = await decodedMs(path, opts);
  if (Math.abs(durationMs - expectedMs) > DURATION_TOLERANCE_MS) throw new EpisodeVerificationError(`${path} lasts ${durationMs} ms, but its timeline is ${expectedMs} ms`);
  const l = await measureLoudness(path, opts);
  if (!meetsTargets(l, targets)) throw new EpisodeVerificationError(`${path} measures ${l.integratedLufs} LUFS and ${l.truePeakDbtp} dBTP; the targets are ${targets.lufs} ±${targets.tolerance} LUFS and at most ${targets.maxTruePeak} dBTP`);
  return { durationMs, ...l };
}

/** Check a mixed episode's files against the timeline they were rendered from. Throws EpisodeVerificationError. */
export async function verifyEpisode(files: { cleanPath: string; amPath: string; vttPath: string }, timeline: Timeline, opts: FfmpegOptions & { targets?: MasterTargets } = {}): Promise<EpisodeVerification> {
  const targets = opts.targets ?? DEFAULT_TARGETS;
  const expectedMs = Math.round((timeline.totalFrames / timeline.sampleRate) * 1000);
  const clean = await verifyMp3(files.cleanPath, expectedMs, targets, opts);
  const am = await verifyMp3(files.amPath, expectedMs, targets, opts);
  const vtt = await readFile(files.vttPath, "utf8").catch(() => "");
  if (!vtt.startsWith("WEBVTT")) throw new EpisodeVerificationError(`${files.vttPath} is not a WebVTT transcript`);
  const transcriptCues = (vtt.match(/-->/g) ?? []).length;
  const spoken = timeline.items.filter((i) => i.kind === "speech").length;
  if (transcriptCues < spoken) throw new EpisodeVerificationError(`the transcript has ${transcriptCues} cues for ${spoken} spoken lines`);
  return { clean, am, transcriptCues };
}

export interface PlacedSound {
  /** The library asset. */
  id: string;
  /** For music: the Script's cue it plays. */
  cue?: string;
  kind: "sfx" | "music";
  /** Where in the Script it is. */
  path: string;
  startMs: number;
  durationMs: number;
  looped: boolean;
  sha256: string;
  licence: string;
  source: unknown;
}

export interface PlacedBed {
  sceneId: string;
  id: string;
  startMs: number;
  endMs: number;
  gainDb: number | undefined;
  sha256: string;
  licence: string;
}

/** Every sound on the timeline with its file hash, licence and provenance. Pure. */
export function soundReport(timeline: Timeline, catalogue: SfxCatalogue): { sounds: PlacedSound[]; beds: PlacedBed[] } {
  const index = indexSfx(catalogue);
  const ms = (frames: number) => Math.round((frames / timeline.sampleRate) * 1000);
  const sounds: PlacedSound[] = [];
  for (const item of timeline.items) {
    if (item.kind !== "sfx" && item.kind !== "music") continue;
    // A music item is named by its cue (theme, sting, transition); the library pins the asset.
    const assetId = item.kind === "music" ? (catalogue.musicCues as Record<string, string | undefined>)[item.id] ?? item.id : item.id;
    const e = index.get(assetId);
    if (!e) throw new EpisodeVerificationError(`the timeline uses "${item.id}", which is not in the sound library`);
    sounds.push({ id: e.id, ...(item.kind === "music" ? { cue: item.id } : {}), kind: item.kind, path: item.ref.path, startMs: ms(item.startFrame), durationMs: ms(item.frames), looped: item.loop, sha256: e.sha256, licence: e.source.licence, source: e.source });
  }
  const beds: PlacedBed[] = [];
  for (const scene of timeline.scenes) {
    if (!scene.ambience) continue;
    const e = index.get(scene.ambience.id);
    if (!e) throw new EpisodeVerificationError(`scene ${scene.id} uses the bed "${scene.ambience.id}", which is not in the sound library`);
    beds.push({ sceneId: scene.id, id: e.id, startMs: ms(scene.startFrame), endMs: ms(scene.endFrame), gainDb: scene.ambience.gainDb, sha256: e.sha256, licence: e.source.licence });
  }
  return { sounds, beds };
}
