import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CastingPausedError, ScriptSchema, buildCast, nameKey, type Script, type SfxCatalogue, type Station, type VoiceCatalogue } from "@midnight-radio/core";
import { OverBudgetError, loadCast, loadValidScript, storedAttempt, writeAdaptation, writeCast, type BudgetLedger, type StoredCast } from "@midnight-radio/db";
import { LlmError, adaptWithRepair, extractCharacters, type LlmProvider } from "@midnight-radio/llm";
import { mixEpisode, segmentsInOrder, type AudioFile, type FfmpegOptions } from "@midnight-radio/mix";
import { RenderCache, planRender, renderSegments, type SegmentOutcome, type TtsProvider } from "@midnight-radio/tts";
import { promptCast, speechLines, validationCast } from "./cast-lines.js";
import type { BookPlan, PlannedEpisode } from "./plan.js";
import { mergeStations, readStations, writeStations } from "./stations.js";

/**
 * EPUB to stations, with no choices left to a person: store the book, cast it once (one voice
 * per character for the whole book), adapt each chosen chapter with repair, render its speech
 * through the render cache, mix it, and publish it as a station. Every step is resumable: a rerun
 * reuses the stored Cast, valid Scripts, cached renders and finished episodes. The same steps run
 * from the `pnpm generate` CLI and from the worker's `episode` job; in a job every write goes
 * through the lease-fenced `publish`, so a worker that lost its job cannot publish.
 */

/** A reason to stop, with a message saying what to do. In a job it fails the job without retries. */
export class GenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateError";
  }
}

/** A budget cap was reached. In a job it parks the job as `over_budget`. */
export class BudgetStopError extends OverBudgetError {
  constructor(message: string) {
    super(message);
    this.name = "BudgetStopError";
  }
}

export interface GenerateDeps {
  db: DatabaseSync;
  ledger: BudgetLedger;
  /** Needed only while something is left to cast or adapt (see `needsLlm`). */
  llm: LlmProvider | null;
  tts: TtsProvider;
  voices: VoiceCatalogue;
  sfx: SfxCatalogue;
  sfxDir: string;
  styleGuide: string;
  /** Speech render cache folder. */
  cacheDir: string;
  /** `apps/web/public`: episodes/<station>/ and stations.json go here. */
  publicDir: string;
  log: (message: string) => void;
  ff?: FfmpegOptions;
  /** Back-off between LLM retries (tests pass a no-op). */
  delay?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  /** A job's id, recorded with every reservation. */
  jobId?: string;
  /** A job's lease check, run inside every budget reservation and before episode files are published. */
  fence?: () => void;
  /** Runs a database write in one transaction (a job passes its fenced `publish`). */
  publish?: <T>(fn: (db: DatabaseSync) => T) => T;
  signal?: AbortSignal;
  /** Errors that stop rendering at once instead of failing one line (a job passes `isFatalJobError`, so a lost lease stops it). */
  isFatal?: (err: unknown) => boolean;
}

export interface GenerateOptions {
  /** 1-based chapter numbers to produce episodes for. Casting always covers the whole book. */
  chapters: ReadonlySet<number>;
  /** The Book's speech budget in characters (`books.char_budget`). */
  charBudget: number;
}

export type EpisodeResult = { stationId: string; episodeNumber: number; title: string } & (
  | { status: "ready"; durationMs: number; reused: boolean }
  | { status: "failed"; reason: string }
);

const selected = (plan: BookPlan, opts: GenerateOptions) => plan.episodes.filter((e) => opts.chapters.has(e.chapterNumber));

function inTransaction<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn(db);
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
const publishOf = (deps: GenerateDeps) => deps.publish ?? (<T>(fn: (db: DatabaseSync) => T) => inTransaction(deps.db, fn));
const jobFields = (deps: GenerateDeps) => ({ ...(deps.jobId ? { jobId: deps.jobId } : {}), ...(deps.fence ? { fence: deps.fence } : {}), ...(deps.signal ? { signal: deps.signal } : {}) });

/** Store the book and every adaptation unit, once. Re-running is a no-op apart from the budget. */
export function storeBook(db: DatabaseSync, plan: BookPlan, charBudget: number, now = Date.now()): void {
  inTransaction(db, () => {
    db.prepare("INSERT INTO books (id, title, author, source_hash, char_budget, status, created_at) VALUES (?, ?, ?, ?, ?, 'ready', ?) ON CONFLICT(id) DO UPDATE SET char_budget = excluded.char_budget").run(
      plan.bookId,
      plan.title,
      plan.author,
      plan.sourceHash,
      charBudget,
      now,
    );
    const insert = db.prepare(
      `INSERT INTO chapters (id, book_id, idx, title, part, part_count, source_text, canonical_text, quote_spans_json, quote_parse_status,
         quote_diagnostics_json, quote_parser_version, normaliser_version, word_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready') ON CONFLICT(id) DO NOTHING`,
    );
    for (const e of plan.episodes) {
      insert.run(
        e.chapterId,
        plan.bookId,
        e.chapter.idx,
        e.chapter.title,
        e.part.part,
        e.part.partCount,
        e.part.sourceText,
        e.part.canonicalText,
        JSON.stringify(e.quotes),
        e.quoteParse.status,
        JSON.stringify(e.quoteParse.diagnostics),
        e.quoteParse.parserVersion,
        e.chapter.normaliserVersion,
        e.part.wordCount,
      );
    }
  });
}

/** Whether this run will call the LLM: the book has no Cast yet, or a chosen chapter has no valid Script. */
export function needsLlm(db: DatabaseSync, plan: BookPlan, opts: GenerateOptions): boolean {
  if (!loadCast(db, plan.bookId)) return true;
  return selected(plan, opts).some((e) => !loadValidScript(db, e.chapterId));
}

function finishedEpisode(db: DatabaseSync, chapterId: string, publicDir: string, stationId: string): { durationMs: number } | null {
  const row = db.prepare("SELECT duration_ms AS durationMs, stale FROM episodes WHERE chapter_id = ?").get(chapterId) as { durationMs: number; stale: number } | undefined;
  if (!row || row.stale !== 0) return null;
  const dir = join(publicDir, "episodes", stationId);
  return ["episode.mp3", "episode-am.mp3", "episode.vtt"].every((f) => existsSync(join(dir, f))) ? { durationMs: Number(row.durationMs) } : null;
}

const stopOn = (err: unknown): never => {
  if (err instanceof OverBudgetError) throw new BudgetStopError(`${err.message} Raise the limit in .env (GLOBAL_DAILY_LLM_TOKEN_LIMIT, GLOBAL_DAILY_TTS_CHAR_LIMIT or BOOK_TTS_CHAR_LIMIT) or wait for the next UTC day, then run again; finished work is kept`);
  if (err instanceof LlmError && !err.retryable) throw new GenerateError(`the LLM refused the request: ${err.message}. Check LLM_API_KEY, LLM_MODEL and LLM_BASE_URL`);
  throw err;
};

/** The Book's Cast: the stored one, or a new one from the whole book (casting once, Req 2.1–2.3). */
export async function castBook(plan: BookPlan, deps: GenerateDeps): Promise<StoredCast> {
  const existing = loadCast(deps.db, plan.bookId);
  if (existing) return existing;
  if (!deps.llm) throw new GenerateError("the book has no Cast yet and no LLM is configured");
  const chapters = [...new Map(plan.episodes.map((e) => [e.chapter.idx, { idx: e.chapter.idx, canonicalText: e.chapter.canonicalText }])).values()];
  deps.log(`casting: reading the whole book (${chapters.length} chapters) for its characters`);
  const extracted = await extractCharacters({
    provider: deps.llm,
    ledger: deps.ledger,
    bookId: plan.bookId,
    chapters,
    onProgress: (done, total) => deps.log(`casting: ${done}/${total} excerpts read`),
    ...jobFields(deps),
    ...(deps.delay ? { delay: deps.delay } : {}),
  }).catch(stopOn);
  let members;
  let pin;
  try {
    ({ pin, members } = buildCast(extracted.inventory, deps.voices));
  } catch (err) {
    if (err instanceof CastingPausedError) throw new GenerateError(`casting stopped: ${err.message}`);
    throw err;
  }
  publishOf(deps)((db) => writeCast(db, plan.bookId, pin, members));
  const cast = loadCast(deps.db, plan.bookId)!;
  deps.log(`cast: ${cast.characters.length} characters, ${cast.characters.filter((c) => c.voiceId).length} with voices`);
  return cast;
}

async function scriptFor(plan: BookPlan, e: PlannedEpisode, cast: StoredCast, deps: GenerateDeps): Promise<{ script: Script; scriptId: string } | { failed: string }> {
  const stored = loadValidScript(deps.db, e.chapterId);
  if (stored) return { script: ScriptSchema.parse(stored.script), scriptId: stored.id };
  if (!deps.llm) throw new GenerateError(`episode ${e.episodeNumber} has no valid Script yet and no LLM is configured`);
  deps.log(`episode ${e.episodeNumber}: adapting "${e.title}" (${e.part.wordCount} words)`);
  const outcome = await adaptWithRepair({
    provider: deps.llm,
    ledger: deps.ledger,
    bookId: plan.bookId,
    chapterId: e.chapterId,
    input: {
      book: { title: plan.title, author: plan.author },
      chapter: { idx: e.chapter.idx, title: e.title, part: e.part.part, partCount: e.part.partCount, canonicalText: e.part.canonicalText },
      episodeNumber: e.episodeNumber,
      cast: promptCast(cast),
      sfx: deps.sfx,
      styleGuide: deps.styleGuide,
    },
    validation: { sourceText: e.part.sourceText, canonicalText: e.part.canonicalText, quoteParse: e.quoteParse, quotes: e.quotes, cast: validationCast(cast), sfx: deps.sfx },
    ...jobFields(deps),
    ...(deps.delay ? { delay: deps.delay } : {}),
  }).catch(stopOn);
  const written = publishOf(deps)((db) =>
    writeAdaptation(db, e.chapterId, {
      status: outcome.status === "valid" ? "adapted" : "failed",
      ...(outcome.status === "failed" ? { message: outcome.message } : {}),
      providerId: outcome.providerId,
      attempts: outcome.attempts.map(storedAttempt),
    }),
  );
  if (outcome.status === "failed") return { failed: `adaptation failed (${outcome.reason}): ${outcome.message}` };
  deps.log(`episode ${e.episodeNumber}: script valid (fidelity ${outcome.report.fidelity?.toFixed(2) ?? "n/a"}, ${outcome.attempts.length} attempt(s))`);
  return { script: outcome.script, scriptId: written.find((w) => w.status === "valid")!.id };
}

/**
 * One row per Script segment (`segments`), so a Cast edit can invalidate exactly the changed
 * characters' lines. Dialogue rows carry the Cast member's stored name, which is what the edit
 * matches. Existing rows are kept.
 */
function writeSegmentRows(db: DatabaseSync, scriptId: string, script: Script, cast: StoredCast): void {
  const byKey = new Map(cast.characters.map((c) => [nameKey(c.name), c.name]));
  const insert = db.prepare(
    `INSERT OR IGNORE INTO segments (id, script_id, section, scene_idx, idx, kind, speaker, text, contains_verbatim_quote, sfx_id, delivery, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  );
  for (const { ref, segment: s } of segmentsInOrder(script)) {
    insert.run(
      randomUUID(),
      scriptId,
      ref.section,
      ref.sceneIdx,
      ref.idx,
      s.kind,
      s.kind === "dialogue" ? (byKey.get(nameKey(s.speaker)) ?? s.speaker) : null,
      "text" in s ? s.text : null,
      "containsVerbatimQuote" in s && s.containsVerbatimQuote ? 1 : 0,
      s.kind === "sfx" ? s.sfxId : null,
      "delivery" in s ? (s.delivery ?? null) : null,
    );
  }
}

function markRendered(db: DatabaseSync, scriptId: string, script: Script, outcomes: SegmentOutcome[]): void {
  const byPath = new Map(outcomes.map((o) => [o.id, o]));
  const update = db.prepare(
    `UPDATE segments SET cache_key = ?, audio_path = ?, duration_ms = ?, status = 'rendered'
     WHERE script_id = ? AND section = ? AND IFNULL(scene_idx, -1) = ? AND idx = ?`,
  );
  for (const { ref } of segmentsInOrder(script)) {
    const o = byPath.get(ref.path);
    if (!o || o.status === "failed") continue;
    update.run(o.result.key, o.result.path, Math.round((o.result.info.frames / 24_000) * 1000), scriptId, ref.section, ref.sceneIdx ?? -1, ref.idx);
  }
}

async function renderAndMix(plan: BookPlan, e: PlannedEpisode, script: Script, scriptId: string, cast: StoredCast, deps: GenerateDeps): Promise<{ durationMs: number } | { failed: string }> {
  // One cache view per episode, so every reservation records its chapter (Req 8.4).
  const cache = new RenderCache({
    dir: deps.cacheDir,
    provider: deps.tts,
    around: (info, call) =>
      deps.ledger.withReservation(
        { bookId: plan.bookId, chapterId: e.chapterId, ...(deps.jobId ? { jobId: deps.jobId } : {}), ttsChars: info.chars },
        async () => ({ value: await call(), usage: { ttsChars: info.chars } }),
        deps.fence ? { fence: deps.fence } : {},
      ),
  });
  const lines = speechLines(script, cast);
  const estimate = await planRender(cache, lines);
  if (estimate.problems.length > 0) return { failed: `speech cannot be rendered: ${estimate.problems.map((p) => `${p.id}: ${p.message}`).join("; ")}` };
  publishOf(deps)((db) => writeSegmentRows(db, scriptId, script, cast));
  deps.log(`episode ${e.episodeNumber}: ${lines.length} lines, ${estimate.toRenderChars} of ${estimate.totalChars} characters to render (about ${Math.ceil(estimate.estimatedRenderMs / 60_000)} min)`);
  let done = 0;
  const outcomes = await renderSegments(lines, {
    cache,
    ...(deps.jobId ? { jobId: deps.jobId } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.isFatal ? { isFatal: deps.isFatal } : {}),
    onSegment: () => {
      done++;
      if (done % 10 === 0 || done === lines.length) deps.log(`episode ${e.episodeNumber}: ${done}/${lines.length} lines rendered`);
    },
  }).catch(stopOn);
  publishOf(deps)((db) => markRendered(db, scriptId, script, outcomes));
  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0) return { failed: `${failed.length} line(s) failed to render (first: ${failed[0]!.status === "failed" ? failed[0]!.error.message : ""}); run again to retry` };
  const speech = new Map<string, AudioFile>(outcomes.flatMap((o) => (o.status === "failed" ? [] : [[o.id, { path: o.result.path, frames: o.result.info.frames }] as const])));

  const outDir = join(deps.publicDir, "episodes", e.stationId);
  await mkdir(outDir, { recursive: true });
  const workDir = await mkdtemp(join(tmpdir(), "mr-mix-"));
  try {
    deps.fence?.();
    const out = await mixEpisode(
      {
        script,
        speech,
        sfx: deps.sfx,
        sfxDir: deps.sfxDir,
        workDir,
        outDir,
        tags: {
          title: `Episode ${e.episodeNumber}: ${e.title}`,
          album: `Midnight Radio: ${plan.title}`,
          artist: plan.author ?? "Unknown author",
          track: e.episodeNumber,
          aiDisclosure: `AI-generated radio adaptation: script by a language model from the book's text, voices by ${deps.tts.identity.model}.`,
        },
      },
      deps.ff,
    );
    publishOf(deps)((db) =>
      db
        .prepare(
          `INSERT INTO episodes (id, chapter_id, mp3_path, clean_mp3_path, vtt_path, duration_ms, lufs, true_peak, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(chapter_id) DO UPDATE SET mp3_path = excluded.mp3_path, clean_mp3_path = excluded.clean_mp3_path, vtt_path = excluded.vtt_path,
             duration_ms = excluded.duration_ms, lufs = excluded.lufs, true_peak = excluded.true_peak, stale = 0`,
        )
        .run(e.stationId, e.chapterId, out.am.path, out.clean.path, out.vttPath, out.clean.durationMs, out.clean.integratedLufs, out.clean.truePeakDbtp),
    );
    return { durationMs: out.clean.durationMs };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Produce one episode (adapt if needed, render, mix) and put it on the dial. A finished, current
 * episode is reused; a stale one (after a Cast edit) is re-rendered, which renders only the lines
 * whose voice changed, since every other line is still in the render cache.
 */
export async function produceEpisode(plan: BookPlan, e: PlannedEpisode, cast: StoredCast, deps: GenerateDeps): Promise<EpisodeResult> {
  const base = { stationId: e.stationId, episodeNumber: e.episodeNumber, title: e.title };
  const finished = finishedEpisode(deps.db, e.chapterId, deps.publicDir, e.stationId);
  let result: EpisodeResult;
  if (finished) {
    result = { ...base, status: "ready", durationMs: finished.durationMs, reused: true };
  } else {
    const s = await scriptFor(plan, e, cast, deps);
    const mixed = "failed" in s ? s : await renderAndMix(plan, e, s.script, s.scriptId, cast, deps);
    result = "failed" in mixed ? { ...base, status: "failed", reason: mixed.failed } : { ...base, status: "ready", durationMs: mixed.durationMs, reused: false };
  }
  if (result.status === "ready") {
    const station: Station = {
      status: "ready",
      id: e.stationId,
      book: plan.title.slice(0, 200),
      author: (plan.author ?? "Unknown author").slice(0, 200),
      episodeNumber: e.episodeNumber,
      title: e.title.slice(0, 200),
      durationMs: result.durationMs,
      cleanUrl: `/episodes/${e.stationId}/episode.mp3`,
      amUrl: `/episodes/${e.stationId}/episode-am.mp3`,
      vttUrl: `/episodes/${e.stationId}/episode.vtt`,
    };
    const stationsPath = join(deps.publicDir, "stations.json");
    await mkdir(deps.publicDir, { recursive: true });
    deps.fence?.();
    await writeStations(stationsPath, mergeStations(await readStations(stationsPath), [station]));
    deps.log(`episode ${e.episodeNumber}: ${result.reused ? "already on air" : "on air"} as ${e.stationId} (${(result.durationMs / 60_000).toFixed(1)} min)`);
  } else {
    deps.log(`episode ${e.episodeNumber}: not produced: ${result.reason}`);
  }
  return result;
}

/** Run the whole flow for the chosen chapters. Per-episode failures are reported and the run goes on; budget and access problems stop it. */
export async function generateBook(plan: BookPlan, opts: GenerateOptions, deps: GenerateDeps): Promise<EpisodeResult[]> {
  const episodes = selected(plan, opts);
  if (episodes.length === 0) throw new GenerateError("no chapters selected");
  storeBook(deps.db, plan, opts.charBudget);
  const cast = await castBook(plan, deps);
  const results: EpisodeResult[] = [];
  for (const e of episodes) results.push(await produceEpisode(plan, e, cast, deps));
  return results;
}
