/**
 * The studio page's decisions, kept pure so they can be tested without a browser: what may be
 * uploaded, how a character's voice is described, how an episode's state reads, and when to poll.
 * Types mirror `GET /api/books/:id` (apps/web/src/server/books.ts).
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type EpisodeState = "not_started" | "queued" | "running" | "over_budget" | "failed" | "ready" | "stale";

export interface EpisodeView {
  chapterId: string;
  episodeNumber: number;
  title: string;
  stationId: string;
  state: EpisodeState;
  message: string | null;
  linesRendered: number;
  linesTotal: number;
  revision: number | null;
  soundDesigned: boolean;
  hasScript: boolean;
  job: null | {
    kind: "episode" | "sound-design";
    state: "queued" | "running" | "done" | "failed" | "over_budget";
    message: string | null;
    cancelRequested: boolean;
    soundDesign: boolean;
    progress: Partial<Record<Stage, StageView>>;
  };
}
export const STAGES = ["library", "script", "speech", "mix"] as const;
export type Stage = (typeof STAGES)[number];
export interface StageView {
  state: "pending" | "running" | "done" | "skipped" | "failed";
  done: number;
  total: number;
  message: string | null;
}

export interface CharacterView {
  name: string;
  description: string | null;
  speaks: boolean;
  voiceId: string | null;
  voiceFit: string | null;
}

export interface VoiceView {
  id: string;
  name: string;
  gender: string;
  ageBands: string[];
  description: string | null;
}

export interface BookView {
  id: string;
  title: string;
  author: string | null;
  charBudget: number;
  charCeiling: number;
  charsSpent: number;
  chapters: { number: number; title: string; words: number; episodes: EpisodeView[] }[];
  cast: null | { announcerVoiceId: string; narratorVoiceId: string; characters: CharacterView[] };
  voices: VoiceView[];
}

/** Why a file cannot be uploaded, or null if it can (the server checks again). */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (!/\.epub$/i.test(file.name)) return "Choose an .epub file.";
  if (file.size > MAX_UPLOAD_BYTES) return "The file is larger than 20 MB.";
  if (file.size === 0) return "The file is empty.";
  return null;
}

/** The voice description a character's voice was designed from, or null (silent, or cast from the series voices). */
export function voiceBrief(book: BookView, character: Pick<CharacterView, "voiceId">): string | null {
  if (!character.voiceId) return null;
  return book.voices.find((v) => v.id === character.voiceId)?.description ?? null;
}

/** A short label for an episode's state, with progress while rendering. */
export function stateLabel(e: EpisodeView): string {
  switch (e.state) {
    case "not_started":
      return "Not started";
    case "queued":
      return "Waiting for the studio";
    case "running":
      return e.linesTotal > 0 ? `Recording: ${e.linesRendered} of ${e.linesTotal} lines` : "Writing the script";
    case "over_budget":
      return "Paused: budget reached";
    case "failed":
      return "Could not be made";
    case "ready":
      return e.revision !== null ? `On air (revision ${e.revision}${e.soundDesigned ? ", with sound design" : ""})` : "On air";
    case "stale":
      return "Needs re-recording";
  }
}

/** Whether the episode has a job waiting or running (generation or a remix). */
export const jobActive = (e: EpisodeView): boolean => e.job?.state === "queued" || e.job?.state === "running";
/** Keep polling while any episode is waiting or being made. */
export const shouldPoll = (book: BookView | null): boolean => !!book?.chapters.some((c) => c.episodes.some((e) => e.state === "queued" || e.state === "running" || jobActive(e)));
const STAGE_NAMES: Record<Stage, string> = { library: "Sound library", script: "Script", speech: "Speech", mix: "Mix" };
const STATE_NAMES: Record<StageView["state"], string> = { pending: "waiting", running: "working", done: "done", skipped: "skipped", failed: "failed" };
/**
 * One line per stage of a sound-designed job (library, script, speech, mix), each with its own
 * progress, in order. Empty for jobs of the original flow, which report no stages.
 */
export function stageLines(e: EpisodeView): { stage: Stage; text: string; state: StageView["state"] }[] {
  const p = e.job?.progress ?? {};
  return STAGES.flatMap((stage) => {
    const v = p[stage];
    if (!v) return [];
    const count = v.total > 0 ? ` ${v.done}/${v.total}` : "";
    return [{ stage, state: v.state, text: `${STAGE_NAMES[stage]}: ${STATE_NAMES[v.state]}${count}${v.message ? ` · ${v.message}` : ""}` }];
  });
}
/** The chosen chapters whose episodes all have a saved Script, so sounds can be added. */
export const remixableChapters = (book: BookView, chosen: ReadonlySet<number>): number[] =>
  book.chapters.filter((c) => chosen.has(c.number) && c.episodes.length > 0 && c.episodes.every((e) => e.hasScript)).map((c) => c.number);
/** The chosen chapters with a job that can be cancelled. */
export const cancellableChapters = (book: BookView, chosen: ReadonlySet<number>): number[] =>
  book.chapters.filter((c) => chosen.has(c.number) && c.episodes.some((e) => jobActive(e) && !e.job!.cancelRequested)).map((c) => c.number);

/** Chapters that still have something to make. */
export const unfinishedChapters = (book: BookView): number[] => book.chapters.filter((c) => c.episodes.some((e) => e.state !== "ready")).map((c) => c.number);
