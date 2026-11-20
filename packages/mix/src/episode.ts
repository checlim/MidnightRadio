import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { indexSfx, resolveMusicCue, type Script, type SfxCatalogue, type SfxEntry } from "@midnight-radio/core";
import { validateWav } from "@midnight-radio/tts";
import type { FfmpegOptions } from "./ffmpeg.js";
import { masterToMp3, renderAm, type MasterResult, type MasterTargets, type Mp3Tags } from "./master.js";
import { renderMix } from "./render.js";
import { SAMPLE_RATE, TimelineError, buildTimeline, type AudioFile, type Timeline } from "./timeline.js";
import { chapterMarkers, webVtt, type ChapterMarker } from "./transcript.js";

/**
 * One episode, from rendered speech to the files the player serves (Tasks 9.1–9.5): the
 * timeline, the clean mix and its AM variant, both mastered to tagged MP3 with chapters, and the
 * WebVTT transcript, all from the same timeline. Files are named `episode.mp3`, `episode-am.mp3`
 * and `episode.vtt` inside `outDir`.
 */

export interface EpisodeInput {
  script: Pick<Script, "coldOpen" | "scenes" | "close">;
  /** Rendered speech by segment path (`scenes[1].segments[3]`), e.g. from `renderSegments`. */
  speech: ReadonlyMap<string, AudioFile>;
  sfx: SfxCatalogue;
  /** `assets/sfx`, the folder the catalogue's paths are relative to. */
  sfxDir: string;
  workDir: string;
  outDir: string;
  tags: Mp3Tags;
  targets?: MasterTargets;
}

export interface EpisodeOutput {
  timeline: Timeline;
  chapters: ChapterMarker[];
  clean: MasterResult & { path: string };
  am: MasterResult & { path: string };
  vttPath: string;
}

/** Frames of a library WAV, read from its header (24 kHz mono 16-bit, as assembled). */
async function framesOf(path: string): Promise<number> {
  const info = validateWav(await readFile(path), { sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, maxDurationMs: 600_000 });
  return info.frames;
}

export async function mixEpisode(input: EpisodeInput, opts: FfmpegOptions = {}): Promise<EpisodeOutput> {
  const index = indexSfx(input.sfx);
  const files = new Map<string, AudioFile & { loopable: boolean }>();
  const asset = async (entry: SfxEntry) => {
    let a = files.get(entry.id);
    if (!a) {
      const path = join(input.sfxDir, entry.path);
      a = { path, frames: await framesOf(path), loopable: entry.loopable };
      files.set(entry.id, a);
    }
    return a;
  };
  // Resolve every library file the Script uses before building the timeline (which is synchronous).
  for (const scene of input.script.scenes) if (scene.ambience && index.has(scene.ambience.id)) await asset(index.get(scene.ambience.id)!);
  const all = [...input.script.coldOpen, ...input.script.scenes.flatMap((s) => s.segments), ...input.script.close];
  for (const seg of all) {
    if (seg.kind === "sfx" && index.has(seg.sfxId)) await asset(index.get(seg.sfxId)!);
    if (seg.kind === "music") {
      const r = resolveMusicCue(input.sfx, index, seg.cue);
      if (!("code" in r)) await asset(r);
    }
  }

  const timeline = buildTimeline(input.script, (ref, seg) => {
    if (seg.kind === "sfx") {
      const a = files.get(seg.sfxId);
      return a ? { asset: a } : {};
    }
    if (seg.kind === "music") {
      const r = resolveMusicCue(input.sfx, index, seg.cue);
      return "code" in r ? {} : { asset: files.get(r.id)! };
    }
    const s = input.speech.get(ref.path);
    return s ? { speech: s } : {};
  });
  const beds = (id: string) => {
    const a = files.get(id);
    if (!a) throw new TimelineError(`ambience:${id}`, "the ambience bed is not in the sound library");
    return a;
  };

  const clean = join(input.workDir, "clean.wav");
  const am = join(input.workDir, "am.wav");
  await renderMix(timeline, clean, { ...opts, beds, workDir: input.workDir });
  await renderAm(clean, am, opts);
  const chapters = chapterMarkers(timeline);
  const meta = { tags: input.tags, chapters, workDir: input.workDir, ...(input.targets ? { targets: input.targets } : {}) };
  const cleanPath = join(input.outDir, "episode.mp3");
  const amPath = join(input.outDir, "episode-am.mp3");
  const cleanResult = await masterToMp3(clean, cleanPath, meta, opts);
  const amResult = await masterToMp3(am, amPath, meta, opts);
  const vttPath = join(input.outDir, "episode.vtt");
  await writeFile(vttPath, webVtt(timeline));
  return { timeline, chapters, clean: { ...cleanResult, path: cleanPath }, am: { ...amResult, path: amPath }, vttPath };
}
