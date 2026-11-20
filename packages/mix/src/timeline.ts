import type { Script, Segment } from "@midnight-radio/core";

/**
 * The episode timeline (Task 9.1, Req 6.1). Pure: from a Script and the measured length of every
 * audio file it uses, decide where each sound starts, in samples at 24 kHz. Everything that
 * follows (the mix, the ambience beds and their ducking, the transcript and chapter markers) reads
 * this one timeline, so they cannot disagree.
 *
 * Gaps: 250 ms only between two adjacent speech turns (announcer, narration or dialogue); 600 ms
 * at every scene transition, including cold open → first scene and last scene → close, and it
 * replaces a turn gap rather than adding to it. Sound effects, music and pauses occupy their own
 * time and get no gap. Scene ambience overlaps its scene and does not appear here (Task 9.2).
 */

export const SAMPLE_RATE = 24_000;
export const TURN_GAP_MS = 250;
export const SCENE_GAP_MS = 600;
export const msToFrames = (ms: number): number => Math.round((ms * SAMPLE_RATE) / 1000);
export const framesToMs = (frames: number): number => (frames * 1000) / SAMPLE_RATE;

/** A rendered or library audio file, with its exact length. */
export interface AudioFile {
  path: string;
  /** Sample frames at 24 kHz. */
  frames: number;
}

export type Section = "coldOpen" | "scenes" | "close";

/** Where a segment sits in the Script, e.g. `scenes[1].segments[3]`. */
export interface SegmentRef {
  section: Section;
  /** Set for segments inside a scene. */
  sceneIdx: number | null;
  idx: number;
  path: string;
}

/** What the timeline needs to know about each segment's audio. */
export interface SegmentAudio {
  /** Speech: the rendered line. */
  speech?: AudioFile;
  /** sfx and music: the library file, and whether it may loop to fill a longer request. */
  asset?: AudioFile & { loopable: boolean };
}

export type TimelineItem =
  | { kind: "speech"; ref: SegmentRef; startFrame: number; frames: number; file: string; segmentKind: "announcer" | "narration" | "dialogue"; speaker: string | null; text: string }
  | { kind: "sfx" | "music"; ref: SegmentRef; startFrame: number; frames: number; file: string; /** Frames of the file itself, for looping. */ fileFrames: number; loop: boolean; id: string }
  | { kind: "pause"; ref: SegmentRef; startFrame: number; frames: number };

export interface TimelineScene {
  sceneIdx: number;
  id: string;
  title: string | undefined;
  /** First sample of the scene's first item; last sample (exclusive) of its last item. Gaps around it are not part of it. */
  startFrame: number;
  endFrame: number;
  ambience: { kind: "sfx" | "music"; id: string; gainDb: number | undefined } | undefined;
}

export interface Timeline {
  sampleRate: number;
  totalFrames: number;
  items: TimelineItem[];
  scenes: TimelineScene[];
}

export class TimelineError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "TimelineError";
  }
}

const isSpeech = (s: Segment) => s.kind === "announcer" || s.kind === "narration" || s.kind === "dialogue";

/** Every segment of the Script in playing order, with its reference. */
export function segmentsInOrder(script: Pick<Script, "coldOpen" | "scenes" | "close">): { ref: SegmentRef; segment: Segment }[] {
  const out: { ref: SegmentRef; segment: Segment }[] = [];
  script.coldOpen.forEach((segment, idx) => out.push({ ref: { section: "coldOpen", sceneIdx: null, idx, path: `coldOpen[${idx}]` }, segment }));
  script.scenes.forEach((scene, sceneIdx) => scene.segments.forEach((segment, idx) => out.push({ ref: { section: "scenes", sceneIdx, idx, path: `scenes[${sceneIdx}].segments[${idx}]` }, segment })));
  script.close.forEach((segment, idx) => out.push({ ref: { section: "close", sceneIdx: null, idx, path: `close[${idx}]` }, segment }));
  return out;
}

/** The "block" a segment belongs to: each scene, the cold open and the close are separated by a scene gap. */
const blockOf = (ref: SegmentRef) => (ref.section === "scenes" ? `scene:${ref.sceneIdx}` : ref.section);

export interface BuildOptions {
  turnGapMs?: number;
  sceneGapMs?: number;
}

/**
 * Lay the Script out in time. `audio(ref, segment)` gives each segment's audio; speech needs
 * `speech`, sfx and music need `asset`. A cue's `durationMs` trims it, or, for a loopable asset,
 * repeats it to fill the time; a non-loopable asset is never stretched. Throws TimelineError
 * naming the segment if audio is missing or empty.
 */
export function buildTimeline(script: Pick<Script, "coldOpen" | "scenes" | "close">, audio: (ref: SegmentRef, segment: Segment) => SegmentAudio, opts: BuildOptions = {}): Timeline {
  const turnGap = msToFrames(opts.turnGapMs ?? TURN_GAP_MS);
  const sceneGap = msToFrames(opts.sceneGapMs ?? SCENE_GAP_MS);
  const items: TimelineItem[] = [];
  const sceneSpans = new Map<number, { start: number; end: number }>();
  let cursor = 0;
  let previous: { block: string; speech: boolean } | undefined;

  for (const { ref, segment } of segmentsInOrder(script)) {
    const block = blockOf(ref);
    const speech = isSpeech(segment);
    if (previous) cursor += previous.block !== block ? sceneGap : previous.speech && speech ? turnGap : 0;
    const startFrame = cursor;
    let item: TimelineItem;
    if (segment.kind === "pause") {
      item = { kind: "pause", ref, startFrame, frames: msToFrames(segment.ms) };
    } else if (segment.kind === "sfx" || segment.kind === "music") {
      const a = audio(ref, segment).asset;
      if (!a || a.frames <= 0) throw new TimelineError(ref.path, `no audio for ${segment.kind === "sfx" ? `sound "${segment.sfxId}"` : `music cue "${segment.cue}"`}`);
      const requested = segment.durationMs === undefined ? a.frames : msToFrames(segment.durationMs);
      const frames = a.loopable ? requested : Math.min(requested, a.frames);
      if (frames <= 0) throw new TimelineError(ref.path, "the cue has no length");
      item = { kind: segment.kind, ref, startFrame, frames, file: a.path, fileFrames: a.frames, loop: a.loopable && frames > a.frames, id: segment.kind === "sfx" ? segment.sfxId : segment.cue };
    } else {
      const s = audio(ref, segment).speech;
      if (!s || s.frames <= 0) throw new TimelineError(ref.path, "the line has no rendered audio");
      item = { kind: "speech", ref, startFrame, frames: s.frames, file: s.path, segmentKind: segment.kind, speaker: segment.kind === "dialogue" ? segment.speaker : null, text: segment.text };
    }
    items.push(item);
    cursor = startFrame + item.frames;
    if (ref.sceneIdx !== null) {
      const span = sceneSpans.get(ref.sceneIdx);
      sceneSpans.set(ref.sceneIdx, { start: span ? span.start : startFrame, end: cursor });
    }
    previous = { block, speech };
  }

  const scenes: TimelineScene[] = script.scenes.map((scene, sceneIdx) => {
    const span = sceneSpans.get(sceneIdx)!;
    return { sceneIdx, id: scene.id, title: scene.title, startFrame: span.start, endFrame: span.end, ambience: scene.ambience ? { kind: scene.ambience.kind, id: scene.ambience.id, gainDb: scene.ambience.gainDb } : undefined };
  });
  return { sampleRate: SAMPLE_RATE, totalFrames: cursor, items, scenes };
}

/** Sample ranges where someone is speaking, merged, in order: what the beds are ducked under (Task 9.2). */
export function speechRanges(timeline: Timeline): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const it of timeline.items) {
    if (it.kind !== "speech") continue;
    const last = out[out.length - 1];
    if (last && it.startFrame <= last.end) last.end = Math.max(last.end, it.startFrame + it.frames);
    else out.push({ start: it.startFrame, end: it.startFrame + it.frames });
  }
  return out;
}
