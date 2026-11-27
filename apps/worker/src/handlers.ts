import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ClonableCatalogue, SfxCatalogue } from "@midnight-radio/core";
import { bindJobSnapshot, setProgress, type BudgetLedger } from "@midnight-radio/db";
import { ingestEpub } from "@midnight-radio/ingest";
import type { LlmProvider } from "@midnight-radio/llm";
import type { FfmpegOptions } from "@midnight-radio/mix";
import type { SfxClient, TtsProvider, VoiceDesignPin, VoiceDesigner } from "@midnight-radio/tts";
import { LibraryError, prepareLibrary } from "./generate/library.js";
import { BudgetStopError, GenerateError, castBook, produceEpisode, type EpisodeResult } from "./generate/pipeline.js";
import { produceSoundDesigned } from "./generate/sound-episode.js";
import { planBook, sha256Hex } from "./generate/plan.js";
import { PermanentJobError, isFatalJobError } from "./jobs/errors.js";
import type { JobQueue } from "./jobs/queue.js";
import type { JobHandler } from "./jobs/runner.js";
import type { LogFields } from "./log.js";

export interface HandlerDeps {
  db: DatabaseSync;
  queue: JobQueue;
  /** Every metered LLM call and TTS render must go through `ledger.withReservation`, with `ctx.assertLease` as the fence. Render jobs pass `isFatalJobError` to `renderSegments`. */
  ledger: BudgetLedger;
  /** Present only when generation is enabled (Req 8.5); without it no generation job is registered. */
  generation?: GenerationServices;
}

/** What generation jobs need: providers, catalogues and where files live. */
export interface GenerationServices {
  /** Null when no LLM is configured: casting and adaptation then fail with a clear message. */
  llm: LlmProvider | null;
  /** Connect on first use, so the worker can start before the speech server. */
  ttsFor: (catalogue: ClonableCatalogue, clipDir: string) => Promise<TtsProvider>;
  designer: () => Promise<VoiceDesigner>;
  series: ClonableCatalogue;
  seriesDir: string;
  designPin: VoiceDesignPin;
  /** `<DATA_DIR>/voices`: each book's designed voices. */
  voicesRoot: string;
  sfx: SfxCatalogue;
  sfxDir: string;
  styleGuide: string;
  cacheDir: string;
  broadcastDir: string;
  /** Uploaded EPUBs, one per Book: `<uploadsDir>/<bookId>.epub`. */
  uploadsDir: string;
  log: (message: string, fields?: LogFields) => void;
  /** The shared sound library that sound-designed jobs prepare and mix from. */
  library: SoundLibraryServices;
  ff?: FfmpegOptions;
  delay?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

export interface SoundLibraryServices {
  /** `<DATA_DIR>/sfx-library`. */
  root: string;
  /** `assets/sfx`. */
  sourceDir: string;
  /** Operator-downloaded CC0 music (`music-candidates/`), used only if the committed library lacks a music cue. */
  musicDir: string;
  /** Null when SFX_SERVICE_URL is not set. */
  connect: (() => Promise<SfxClient>) | null;
  takesPerCue?: number;
  /** Tests only. */
  allowFakeModel?: boolean;
}

/** Job kind that produces one episode; its ref is the `chapters.id`. Options: `{ soundDesign: true }` for the sound-designed flow; none for the original flow. */
export const EPISODE_JOB = "episode";
/** Job kind that adds sound design to a saved episode and remixes it; its ref is the `chapters.id`. */
export const SOUND_DESIGN_JOB = "sound-design";

/** Whether a job runs the sound-designed flow. Jobs without options (queued before it existed) run as before. */
export const wantsSoundDesign = (options: Record<string, unknown> | null): boolean => options?.soundDesign === true;

export const uploadPathFor = (uploadsDir: string, bookId: string) => join(uploadsDir, `${bookId}.epub`);

/**
 * `episode` job: cast the Book if it has no Cast yet, then adapt, render, mix and publish the
 * chapter's episode. Re-running it after a Cast edit re-renders only the changed voices' lines.
 * A budget cap parks the job (`over_budget`); a problem a retry cannot fix (no LLM, a refused key,
 * an adaptation that failed its repairs, a changed upload) fails it with the reason; anything else
 * (e.g. the local audio service is down) is retried.
 */
function episodeHandler(deps: HandlerDeps, services: GenerationServices, mode: "episode" | "remix"): JobHandler {
  return async (ctx) => {
    const row = deps.db
      .prepare("SELECT b.id AS bookId, b.source_hash AS sourceHash FROM chapters c JOIN books b ON b.id = c.book_id WHERE c.id = ?")
      .get(ctx.job.refId) as { bookId: string; sourceHash: string } | undefined;
    if (!row) throw new PermanentJobError(`no chapter ${ctx.job.refId}`);
    const bytes = await readFile(uploadPathFor(services.uploadsDir, row.bookId)).catch(() => {
      throw new PermanentJobError("the uploaded EPUB for this book is missing; upload it again");
    });
    const epub = new Uint8Array(bytes);
    if (sha256Hex(epub) !== row.sourceHash) throw new PermanentJobError("the uploaded EPUB for this book has changed since it was stored; upload it again");
    const plan = planBook(await ingestEpub(epub), epub);
    const episode = plan.episodes.find((e) => e.chapterId === ctx.job.refId);
    if (!episode) throw new PermanentJobError(`chapter ${ctx.job.refId} is not in the uploaded book`);

    const pipeline = {
      db: deps.db,
      ledger: deps.ledger,
      llm: services.llm,
      ttsFor: services.ttsFor,
      designer: services.designer,
      series: services.series,
      seriesDir: services.seriesDir,
      designPin: services.designPin,
      voicesRoot: services.voicesRoot,
      sfx: services.sfx,
      sfxDir: services.sfxDir,
      styleGuide: services.styleGuide,
      cacheDir: services.cacheDir,
      broadcastDir: services.broadcastDir,
      log: (m: string) => services.log(m, { jobId: ctx.job.id, chapterId: ctx.job.refId }),
      jobId: ctx.job.id,
      fence: ctx.assertLease,
      publish: ctx.publish,
      signal: ctx.signal,
      isFatal: isFatalJobError,
      ...(services.ff ? { ff: services.ff } : {}),
      ...(services.delay ? { delay: services.delay } : {}),
    };
    const progress = (stage: Parameters<typeof setProgress>[2], p: Parameters<typeof setProgress>[3]) => ctx.publish((db) => setProgress(db, ctx.job.id, stage, p, Date.now()));
    const soundDesigned = mode === "remix" || wantsSoundDesign(ctx.job.options);
    let result: EpisodeResult;
    try {
      if (soundDesigned) progress("library", { state: "pending" });
      const cast = await castBook(plan, pipeline);
      if (!soundDesigned) result = await produceEpisode(plan, episode, cast, pipeline);
      else {
        const lib = services.library;
        result = await produceSoundDesigned(plan, episode, cast, pipeline, {
          mode: mode === "remix" ? "remix" : "generate",
          progress,
          library: () =>
            prepareLibrary({
              db: deps.db,
              root: lib.root,
              sourceDir: lib.sourceDir,
              musicDir: lib.musicDir,
              connect: lib.connect,
              holder: ctx.job.id,
              bind: () => ctx.publish((db) => bindJobSnapshot(db, ctx.job.id)),
              log: pipeline.log,
              progress: (p) => progress("library", p),
              signal: ctx.signal,
              fence: ctx.assertLease,
              ...(lib.takesPerCue ? { takesPerCue: lib.takesPerCue } : {}),
              ...(lib.allowFakeModel ? { allowFakeModel: true } : {}),
              ...(services.ff ? { ff: services.ff } : {}),
            }),
        });
      }
    } catch (err) {
      if (err instanceof BudgetStopError) throw err;
      if (err instanceof GenerateError || err instanceof LibraryError) throw new PermanentJobError(err.message);
      throw err;
    }
    if (result.status === "failed") {
      if (result.reason.startsWith("adaptation failed")) throw new PermanentJobError(result.reason);
      throw new Error(result.reason);
    }
  };
}

/**
 * Job kinds this worker can run. With generation disabled (the default, and always on the live
 * site) there are none, so nothing can render or call a model. Jobs of unregistered kinds stay queued.
 */
export function createHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  if (!deps.generation) return {};
  return { [EPISODE_JOB]: episodeHandler(deps, deps.generation, "episode"), [SOUND_DESIGN_JOB]: episodeHandler(deps, deps.generation, "remix") };
}
