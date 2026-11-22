import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ScriptSchema, buildDesignedCast, nameKey, type ClonableCatalogue, type Script, type SfxCatalogue, type Station } from "@midnight-radio/core";
import { OverBudgetError, loadCast, loadValidScript, storedAttempt, writeAdaptation, writeCast, type BudgetLedger, type StoredCast } from "@midnight-radio/db";
import { LlmError, VoiceBriefError, adaptWithRepair, extractCharacters, writeVoiceBriefs, type LlmProvider } from "@midnight-radio/llm";
import { mixEpisode, segmentsInOrder, type AudioFile, type FfmpegOptions } from "@midnight-radio/mix";
import { RenderCache, TtsError, planRender, renderSegments, type SegmentOutcome, type TtsProvider, type VoiceDesignPin, type VoiceDesigner } from "@midnight-radio/tts";
import { VoiceDesignError, designBookVoices, loadBookCatalogue, readVoicesPlan, writeVoicesPlan } from "./book-voices.js";
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
  /** Connects the speech provider for a book's catalogue: its own voices, or the series voices. */
  ttsFor: (catalogue: ClonableCatalogue, clipDir: string) => Promise<TtsProvider>;
  /** Connects the voice designer; called only while a book's voices are still to be designed. */
  designer: () => Promise<VoiceDesigner>;
  /** The series catalogue (Announcer, Narrator, the voice-clone pin) and its clip folder. */
  series: ClonableCatalogue;
  seriesDir: string;
  /** The voice-design build (`assets/voices/voice-design.json`). */
  designPin: VoiceDesignPin;
  /** `<DATA_DIR>/voices`: each book's designed voices. */
  voicesRoot: string;
  sfx: SfxCatalogue;
  sfxDir: string;
  styleGuide: string;
  /** Speech render cache folder. */
  cacheDir: string;
  /** `<DATA_DIR>/broadcast`: episodes/<station>/ and stations.json go here; the web app serves it at `/broadcast/`. */
  broadcastDir: string;
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

function finishedEpisode(db: DatabaseSync, chapterId: string, broadcastDir: string, stationId: string): { durationMs: number } | null {
  const row = db.prepare("SELECT duration_ms AS durationMs, stale FROM episodes WHERE chapter_id = ?").get(chapterId) as { durationMs: number; stale: number } | undefined;
  if (!row || row.stale !== 0) return null;
  const dir = join(broadcastDir, "episodes", stationId);
  return ["episode.mp3", "episode-am.mp3", "episode.vtt"].every((f) => existsSync(join(dir, f))) ? { durationMs: Number(row.durationMs) } : null;
}

const stopOn = (err: unknown): never => {
  if (err instanceof OverBudgetError) throw new BudgetStopError(`${err.message} Raise the limit in .env (GLOBAL_DAILY_LLM_TOKEN_LIMIT, GLOBAL_DAILY_TTS_CHAR_LIMIT or BOOK_TTS_CHAR_LIMIT) or wait for the next UTC day, then run again; finished work is kept`);
  if (err instanceof LlmError && !err.retryable) throw new GenerateError(`the LLM refused the request: ${err.message}. Check LLM_API_KEY, LLM_MODEL and LLM_BASE_URL`);
  throw err;
};

/**
 * The Book's Cast: the stored one, or a new one (casting once, Req 2.1–2.3). A new Cast reads the
 * whole book for its characters, has the LLM write a voice brief for every speaking character,
 * designs each voice from its brief, and casts every character on their own voice; the Announcer
 * and Narrator keep the series voices. The inventory and briefs are saved before any voice is
 * designed, so a rerun repeats no paid step.
 */
export async function castBook(plan: BookPlan, deps: GenerateDeps): Promise<StoredCast> {
  const existing = loadCast(deps.db, plan.bookId);
  if (existing) return existing;
  let voicesPlan = await readVoicesPlan(deps.voicesRoot, plan.bookId);
  if (!voicesPlan) {
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
    const speakers = extracted.inventory.filter((c) => c.speaks);
    deps.log(`voices: writing a voice brief for each of ${speakers.length} speaking character(s)`);
    const briefs = await writeVoiceBriefs({
      provider: deps.llm,
      ledger: deps.ledger,
      bookId: plan.bookId,
      book: { title: plan.title, author: plan.author },
      characters: speakers.map((c) => ({ name: c.name, aliases: c.aliases, genderPresentation: c.genderPresentation, ageBand: c.ageBand, description: c.description })),
      ...jobFields(deps),
      ...(deps.delay ? { delay: deps.delay } : {}),
    }).catch((err: unknown) => {
      if (err instanceof VoiceBriefError) throw new GenerateError(`casting stopped: ${err.message}`);
      return stopOn(err);
    });
    deps.fence?.();
    await writeVoicesPlan(deps.voicesRoot, plan.bookId, extracted.inventory, briefs);
    voicesPlan = { version: 1, inventory: extracted.inventory, briefs: Object.fromEntries(briefs) };
  }
  const needsDesign = voicesPlan.inventory.some((c) => c.speaks);
  let designer: VoiceDesigner | null = null;
  if (needsDesign) {
    try {
      designer = await deps.designer();
    } catch (err) {
      if (err instanceof TtsError && !err.retryable) throw new GenerateError(`voice design is not available: ${err.message}`);
      throw err;
    }
  }
  let designed;
  try {
    designed = await designBookVoices(plan.bookId, voicesPlan, designer, { voicesRoot: deps.voicesRoot, series: deps.series, seriesDir: deps.seriesDir, designPin: deps.designPin, log: deps.log, ...(deps.fence ? { fence: deps.fence } : {}), ...(deps.signal ? { signal: deps.signal } : {}) });
  } catch (err) {
    if (err instanceof VoiceDesignError) throw new GenerateError(`casting stopped: ${err.message}`);
    throw err;
  }
  const { pin, members } = buildDesignedCast(voicesPlan.inventory, designed.catalogue, designed.voiceFor);
  publishOf(deps)((db) => writeCast(db, plan.bookId, pin, members));
  const cast = loadCast(deps.db, plan.bookId)!;
  deps.log(`cast: ${cast.characters.length} characters, ${cast.characters.filter((c) => c.voiceId).length} with their own designed voice`);
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
  // The speech provider for this book's own voices (the catalogue its Cast is pinned to).
  let tts: TtsProvider;
  try {
    const { catalogue, clipDir } = await loadBookCatalogue(deps.voicesRoot, plan.bookId, deps.series, deps.seriesDir, cast.pin);
    tts = await deps.ttsFor(catalogue, clipDir);
  } catch (err) {
    if (err instanceof VoiceDesignError) throw new GenerateError(err.message);
    throw err;
  }
  // One cache view per episode, so every reservation records its chapter (Req 8.4).
  const cache = new RenderCache({
    dir: deps.cacheDir,
    provider: tts,
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

  const outDir = join(deps.broadcastDir, "episodes", e.stationId);
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
          aiDisclosure: `AI-generated radio adaptation: script by a language model from the book's text, voices by ${tts.identity.model}.`,
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
  const finished = finishedEpisode(deps.db, e.chapterId, deps.broadcastDir, e.stationId);
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
      cleanUrl: `/broadcast/episodes/${e.stationId}/episode.mp3`,
      amUrl: `/broadcast/episodes/${e.stationId}/episode-am.mp3`,
      vttUrl: `/broadcast/episodes/${e.stationId}/episode.vtt`,
    };
    const stationsPath = join(deps.broadcastDir, "stations.json");
    await mkdir(deps.broadcastDir, { recursive: true });
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
