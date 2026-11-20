/**
 * The studio page's decisions, kept pure so they can be tested without a browser: what may be
 * uploaded, which voices a character may take, how an episode's state reads, and when to poll.
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

/**
 * Voices a character can be given: every voice no one else in the Cast holds, never the
 * Announcer's or Narrator's, with the character's own voice first. `pending` holds edits not yet
 * saved, so two characters can swap voices in one change.
 */
export function voiceChoices(book: BookView, name: string, pending: Readonly<Record<string, string>>): VoiceView[] {
  if (!book.cast) return [];
  const current = (c: CharacterView) => pending[c.name] ?? c.voiceId;
  const me = book.cast.characters.find((c) => c.name === name);
  if (!me?.speaks) return [];
  const taken = new Set([book.cast.announcerVoiceId, book.cast.narratorVoiceId, ...book.cast.characters.filter((c) => c.name !== name).map(current)]);
  const mine = current(me);
  const options = book.voices.filter((v) => v.id === mine || !taken.has(v.id));
  return [...options.filter((v) => v.id === mine), ...options.filter((v) => v.id !== mine)];
}

/** Only the edits that change something, ready for `POST /api/books/:id/cast`. */
export function castChanges(book: BookView, pending: Readonly<Record<string, string>>): { name: string; voiceId: string }[] {
  return (book.cast?.characters ?? []).flatMap((c) => (pending[c.name] && pending[c.name] !== c.voiceId ? [{ name: c.name, voiceId: pending[c.name]! }] : []));
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
      return "On air";
    case "stale":
      return "Needs re-recording";
  }
}

/** Keep polling while any episode is waiting or being made. */
export const shouldPoll = (book: BookView | null): boolean => !!book?.chapters.some((c) => c.episodes.some((e) => e.state === "queued" || e.state === "running"));

/** Chapters that still have something to make. */
export const unfinishedChapters = (book: BookView): number[] => book.chapters.filter((c) => c.episodes.some((e) => e.state !== "ready")).map((c) => c.number);
