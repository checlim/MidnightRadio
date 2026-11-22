import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ClonableCatalogue, SfxCatalogue } from "@midnight-radio/core";
import type { BudgetLedger } from "@midnight-radio/db";
import { ingestEpub } from "@midnight-radio/ingest";
import type { LlmProvider } from "@midnight-radio/llm";
import type { FfmpegOptions } from "@midnight-radio/mix";
import type { TtsProvider, VoiceDesignPin, VoiceDesigner } from "@midnight-radio/tts";
import { BudgetStopError, GenerateError, castBook, produceEpisode } from "./generate/pipeline.js";
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
  ff?: FfmpegOptions;
  delay?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

/** Job kind that produces one episode; its ref is the `chapters.id`. */
export const EPISODE_JOB = "episode";

export const uploadPathFor = (uploadsDir: string, bookId: string) => join(uploadsDir, `${bookId}.epub`);

/**
 * `episode` job: cast the Book if it has no Cast yet, then adapt, render, mix and publish the
 * chapter's episode. Re-running it after a Cast edit re-renders only the changed voices' lines.
 * A budget cap parks the job (`over_budget`); a problem a retry cannot fix (no LLM, a refused key,
 * an adaptation that failed its repairs, a changed upload) fails it with the reason; anything else
 * (e.g. the local audio service is down) is retried.
 */
function episodeHandler(deps: HandlerDeps, services: GenerationServices): JobHandler {
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
    let result;
    try {
      const cast = await castBook(plan, pipeline);
      result = await produceEpisode(plan, episode, cast, pipeline);
    } catch (err) {
      if (err instanceof BudgetStopError) throw err;
      if (err instanceof GenerateError) throw new PermanentJobError(err.message);
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
  return { [EPISODE_JOB]: episodeHandler(deps, deps.generation) };
}
