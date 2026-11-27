import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BudgetLedger, getProgress, loadBudgetConfig, loadCast, loadValidScript, type ProgressStage, type StageProgress } from "@midnight-radio/db";
import { IngestError, ingestEpub } from "@midnight-radio/ingest";
import { EPISODE_JOB, JobQueue, SOUND_DESIGN_JOB, planBook, stationIdFor, storeBook, uploadPathFor, type JobState } from "@midnight-radio/worker";
import { z } from "zod";
import type { WebConfig } from "./config";

/**
 * What the generation routes do (Req 1.1, 1.2, 8.2), kept out of the route files so they can
 * be tested directly. Every function takes the open database; errors meant for the person are
 * `HttpError`s with a status and a message fit to show.
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Default per-Book speech budget, lowered to the operator ceiling when that is smaller. */
export const DEFAULT_CHAR_BUDGET = 60_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const toResponse = (err: unknown): Response => {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status, headers: { "cache-control": "no-store" } });
  throw err;
};

/** Read a request body, refusing it as soon as it passes `max` bytes (the upload limit holds without a Content-Length). */
export async function readCapped(request: Request, max = MAX_UPLOAD_BYTES): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) throw new HttpError(413, "The file is larger than 20 MB.");
  if (!request.body) throw new HttpError(400, "No file was sent.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "The file is larger than 20 MB.");
    }
    chunks.push(value);
  }
  if (size === 0) throw new HttpError(400, "No file was sent.");
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

const uploadsDir = (config: WebConfig) => join(config.dataDir, "uploads");

/**
 * Store an uploaded EPUB as a Book: check it, parse it, keep the file for the worker and record
 * the Book and its chapters. A bad, DRM-protected or empty EPUB is refused with the reason and
 * creates nothing. Uploading the same file again returns the same Book unchanged.
 */
export async function uploadBook(db: DatabaseSync, config: WebConfig, fileName: string, bytes: Uint8Array): Promise<BookView> {
  if (!/\.epub$/i.test(fileName.trim())) throw new HttpError(415, "Only .epub files can be uploaded.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, "The file is larger than 20 MB.");
  let book;
  try {
    book = await ingestEpub(bytes);
  } catch (err) {
    if (err instanceof IngestError) throw new HttpError(422, `This EPUB cannot be used: ${err.message}`);
    throw err;
  }
  if (book.chapters.length === 0) throw new HttpError(422, "This EPUB cannot be used: it has no readable story chapters.");
  const plan = planBook(book, bytes);
  const known = db.prepare("SELECT id FROM books WHERE id = ?").get(plan.bookId);
  if (!known) {
    await writeAtomic(uploadPathFor(uploadsDir(config), plan.bookId), bytes);
    storeBook(db, plan, Math.min(DEFAULT_CHAR_BUDGET, config.bookTtsCharCeiling));
  }
  return bookView(db, config, plan.bookId)!;
}

export type EpisodeState = "not_started" | "queued" | "running" | "over_budget" | "failed" | "ready" | "stale";

export interface EpisodeView {
  chapterId: string;
  episodeNumber: number;
  title: string;
  stationId: string;
  state: EpisodeState;
  /** Why the last job stopped (failed or over budget). */
  message: string | null;
  linesRendered: number;
  linesTotal: number;
  /** The episode revision on air (sound-designed episodes), or null for an original-flow episode or none. */
  revision: number | null;
  /** Whether the episode on air was mixed with the sound library (a sound-design revision). */
  soundDesigned: boolean;
  /** Whether there is a saved Script that sounds can be added to. */
  hasScript: boolean;
  /** The newest job for this episode of either kind, with its per-stage progress. */
  job: null | {
    kind: "episode" | "sound-design";
    state: JobState;
    message: string | null;
    cancelRequested: boolean;
    soundDesign: boolean;
    progress: Partial<Record<ProgressStage, Pick<StageProgress, "state" | "done" | "total" | "message">>>;
  };
}

export interface BookView {
  id: string;
  title: string;
  author: string | null;
  charBudget: number;
  charCeiling: number;
  charsSpent: number;
  chapters: { number: number; title: string; words: number; episodes: EpisodeView[] }[];
  cast: null | {
    announcerVoiceId: string;
    narratorVoiceId: string;
    characters: { name: string; description: string | null; speaks: boolean; voiceId: string | null; voiceFit: string | null }[];
  };
}

interface ChapterRow {
  id: string;
  idx: number;
  title: string;
  part: number;
  partCount: number;
  words: number;
}

/** Everything the upload page shows about a Book, or undefined if there is no such Book. */
export function bookView(db: DatabaseSync, config: WebConfig, bookId: string): BookView | undefined {
  const book = db.prepare("SELECT id, title, author, source_hash AS sourceHash, char_budget AS charBudget FROM books WHERE id = ?").get(bookId) as
    | { id: string; title: string; author: string | null; sourceHash: string; charBudget: number }
    | undefined;
  if (!book) return undefined;
  const rows = db
    .prepare("SELECT id, idx, title, part, part_count AS partCount, word_count AS words FROM chapters WHERE book_id = ? ORDER BY idx, part")
    .all(bookId) as unknown as ChapterRow[];
  const job = db.prepare("SELECT state, error FROM jobs WHERE kind = ? AND ref_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1");
  const episode = db.prepare("SELECT e.stale, r.revision, r.snapshot_id AS snapshotId FROM episodes e LEFT JOIN episode_revisions r ON r.id = e.revision_id WHERE e.chapter_id = ?");
  const latest = db.prepare(
    "SELECT id, kind, state, error, cancel_requested AS cancelRequested, options_json AS options FROM jobs WHERE kind IN (?, ?) AND ref_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
  );
  const lines = db.prepare(
    `SELECT COUNT(*) AS total, SUM(g.status = 'rendered') AS rendered FROM segments g
     WHERE g.kind IN ('announcer', 'narration', 'dialogue')
       AND g.script_id = (SELECT id FROM scripts WHERE chapter_id = ? AND status = 'valid' ORDER BY version DESC LIMIT 1)`,
  );
  const chapters = new Map<number, BookView["chapters"][number]>();
  rows.forEach((r, i) => {
    const episodeNumber = i + 1;
    const j = job.get(EPISODE_JOB, r.id) as { state: JobState; error: string | null } | undefined;
    const e = episode.get(r.id) as { stale: number; revision: number | null; snapshotId: string | null } | undefined;
    const last = latest.get(EPISODE_JOB, SOUND_DESIGN_JOB, r.id) as { id: string; kind: "episode" | "sound-design"; state: JobState; error: string | null; cancelRequested: number; options: string | null } | undefined;
    const l = lines.get(r.id) as { total: number; rendered: number | null };
    const state: EpisodeState =
      j?.state === "queued" || j?.state === "running" ? j.state : e ? (e.stale ? "stale" : "ready") : j?.state === "failed" || j?.state === "over_budget" ? j.state : "not_started";
    const view: EpisodeView = {
      chapterId: r.id,
      episodeNumber,
      title: r.partCount > 1 ? `${r.title} (Part ${r.part} of ${r.partCount})` : r.title,
      stationId: stationIdFor(book.title, book.sourceHash, episodeNumber),
      state,
      message: state === "failed" || state === "over_budget" ? (j?.error ?? null) : null,
      linesRendered: Number(l.rendered ?? 0),
      linesTotal: Number(l.total),
      revision: e?.revision === null || e?.revision === undefined ? null : Number(e.revision),
      soundDesigned: Boolean(e?.snapshotId),
      hasScript: loadValidScript(db, r.id) !== undefined,
      job: last
        ? {
            kind: last.kind,
            state: last.state,
            message: last.state === "failed" || last.state === "over_budget" ? last.error : null,
            cancelRequested: Number(last.cancelRequested) === 1,
            soundDesign: last.kind === SOUND_DESIGN_JOB || (last.options !== null && (JSON.parse(last.options) as { soundDesign?: unknown }).soundDesign === true),
            progress: Object.fromEntries(Object.entries(getProgress(db, last.id)).map(([k, v]) => [k, { state: v.state, done: v.done, total: v.total, message: v.message }])),
          }
        : null,
    };
    const ch = chapters.get(r.idx) ?? { number: r.idx + 1, title: r.title, words: 0, episodes: [] };
    ch.words += Number(r.words);
    ch.episodes.push(view);
    chapters.set(r.idx, ch);
  });
  const cast = loadCast(db, bookId);
  const ceiling = config.bookTtsCharCeiling;
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    charBudget: Number(book.charBudget),
    charCeiling: ceiling,
    charsSpent: new BudgetLedger(db, loadBudgetConfig({})).bookSpend(bookId).ttsChars,
    chapters: [...chapters.values()],
    cast: cast
      ? {
          announcerVoiceId: cast.announcer.voiceId!,
          narratorVoiceId: cast.narrator.voiceId!,
          characters: cast.characters.map((c) => ({ name: c.name, description: c.description, speaks: c.speaks, voiceId: c.voiceId, voiceFit: c.voiceFit })),
        }
      : null,
  };
}

export const GenerateRequestSchema = z.strictObject({
  chapters: z.array(z.number().int().min(1)).min(1).max(500),
  charBudget: z.number().int().min(1),
  /** Prepare the sound library first and design sounds into the episodes. Absent or false: the original flow. */
  soundDesign: z.boolean().optional(),
});

export const ChaptersRequestSchema = z.strictObject({
  chapters: z.array(z.number().int().min(1)).min(1).max(500),
});

/**
 * Queue an episode job for every unfinished episode of the chosen chapters, after setting the
 * Book's speech budget. The budget can never exceed the operator ceiling (Req 8.2). A job parked
 * over budget is resumed, so raising the budget lets it carry on.
 */
export function startGeneration(db: DatabaseSync, config: WebConfig, bookId: string, input: unknown): { queued: string[] } {
  const parsed = GenerateRequestSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Send the chapter numbers to generate and a speech budget in characters.");
  const { chapters, charBudget, soundDesign } = parsed.data;
  const view = bookView(db, config, bookId);
  if (!view) throw new HttpError(404, "There is no such book.");
  if (charBudget > config.bookTtsCharCeiling) throw new HttpError(422, `The speech budget cannot be more than this site's limit of ${config.bookTtsCharCeiling.toLocaleString("en")} characters.`);
  const byNumber = new Map(view.chapters.map((c) => [c.number, c]));
  const unknown = chapters.filter((n) => !byNumber.has(n));
  if (unknown.length > 0) throw new HttpError(422, `This book has no chapter ${unknown.join(", ")}.`);
  db.prepare("UPDATE books SET char_budget = ? WHERE id = ?").run(charBudget, bookId);
  const queue = new JobQueue(db);
  const queued: string[] = [];
  for (const n of [...new Set(chapters)].sort((a, b) => a - b)) {
    for (const e of byNumber.get(n)!.episodes) {
      if (e.state === "ready") continue;
      const job = soundDesign ? queue.enqueue(EPISODE_JOB, e.chapterId, { soundDesign: true }) : queue.enqueue(EPISODE_JOB, e.chapterId);
      if (job.state === "over_budget") queue.resume(job.id);
      queued.push(e.chapterId);
    }
  }
  return { queued };
}

/** The episodes of the chosen chapters of a Book. */
function chosenEpisodes(db: DatabaseSync, config: WebConfig, bookId: string, input: unknown): EpisodeView[] {
  const parsed = ChaptersRequestSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Send the chapter numbers.");
  const view = bookView(db, config, bookId);
  if (!view) throw new HttpError(404, "There is no such book.");
  const byNumber = new Map(view.chapters.map((c) => [c.number, c]));
  const unknown = parsed.data.chapters.filter((n) => !byNumber.has(n));
  if (unknown.length > 0) throw new HttpError(422, `This book has no chapter ${unknown.join(", ")}.`);
  return [...new Set(parsed.data.chapters)].sort((a, b) => a - b).flatMap((n) => byNumber.get(n)!.episodes);
}

/**
 * Queue a sound-design remix for every episode of the chosen chapters that has a saved Script:
 * sounds are added to that Script and it is remixed, with no new adaptation and its speech from
 * the render cache. The episode on air stays until the remix has passed every check.
 */
export function startSoundDesign(db: DatabaseSync, config: WebConfig, bookId: string, input: unknown): { queued: string[] } {
  const episodes = chosenEpisodes(db, config, bookId, input);
  const missing = episodes.filter((e) => !e.hasScript);
  if (missing.length > 0) throw new HttpError(422, `Generate these episodes first; they have no Script to add sounds to: ${missing.map((e) => e.episodeNumber).join(", ")}.`);
  const busy = episodes.filter((e) => e.job && (e.job.state === "queued" || e.job.state === "running") && e.job.kind === "episode");
  if (busy.length > 0) throw new HttpError(409, `Wait for episode ${busy.map((e) => e.episodeNumber).join(", ")} to finish generating first.`);
  const queue = new JobQueue(db);
  const queued: string[] = [];
  for (const e of episodes) {
    const job = queue.enqueue(SOUND_DESIGN_JOB, e.chapterId);
    if (job.state === "over_budget") queue.resume(job.id);
    queued.push(e.chapterId);
  }
  return { queued };
}

/** Ask the queued or running jobs of the chosen chapters to stop. Finished work is kept. */
export function cancelJobs(db: DatabaseSync, config: WebConfig, bookId: string, input: unknown): { cancelled: string[] } {
  const episodes = chosenEpisodes(db, config, bookId, input);
  const queue = new JobQueue(db);
  const cancelled: string[] = [];
  for (const e of episodes) {
    for (const kind of [EPISODE_JOB, SOUND_DESIGN_JOB]) {
      const row = db.prepare("SELECT id FROM jobs WHERE kind = ? AND ref_id = ? AND state IN ('queued', 'running', 'over_budget')").get(kind, e.chapterId) as { id: string } | undefined;
      if (row && queue.requestCancel(row.id)) cancelled.push(e.chapterId);
    }
  }
  return { cancelled };
}
