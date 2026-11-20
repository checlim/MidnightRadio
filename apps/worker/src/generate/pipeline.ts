import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CastingPausedError, ScriptSchema, buildCast, type Script, type SfxCatalogue, type Station, type VoiceCatalogue } from "@midnight-radio/core";
import { OverBudgetError, loadCast, loadValidScript, saveAdaptation, saveCast, storedAttempt, type BudgetLedger, type StoredCast } from "@midnight-radio/db";
import { LlmError, adaptWithRepair, extractCharacters, type LlmProvider } from "@midnight-radio/llm";
import { mixEpisode, type AudioFile, type FfmpegOptions } from "@midnight-radio/mix";
import { RenderCache, planRender, renderSegments, type TtsProvider } from "@midnight-radio/tts";
import { promptCast, speechLines, validationCast } from "./cast-lines.js";
import type { BookPlan, PlannedEpisode } from "./plan.js";
import { mergeStations, readStations, writeStations } from "./stations.js";

/**
 * EPUB to stations, with no choices left to a person: store the book, cast it once (one voice
 * per character for the whole book), adapt each chosen chapter with repair, render its speech
 * through the render cache, mix it, and publish it as a station. Every step is resumable: a rerun
 * on the same EPUB reuses the stored Cast, valid Scripts, cached renders and finished episodes.
 */

/** A reason to stop the whole run, with a message saying what to do. */
export class GenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateError";
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

/** Store the book and every adaptation unit, once. Re-running is a no-op. */
export function storeBook(db: DatabaseSync, plan: BookPlan, charBudget: number, now = Date.now()): void {
  db.exec("BEGIN IMMEDIATE");
  try {
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
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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
  if (err instanceof OverBudgetError) throw new GenerateError(`${err.message}. Raise the limit in .env (GLOBAL_DAILY_LLM_TOKEN_LIMIT, GLOBAL_DAILY_TTS_CHAR_LIMIT or BOOK_TTS_CHAR_LIMIT) or wait for the next UTC day, then run again; finished work is kept`);
  if (err instanceof LlmError && !err.retryable) throw new GenerateError(`the LLM refused the request: ${err.message}. Check LLM_API_KEY, LLM_MODEL and LLM_BASE_URL`);
  throw err;
};

async function castBook(plan: BookPlan, deps: GenerateDeps): Promise<StoredCast> {
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
    ...(deps.delay ? { delay: deps.delay } : {}),
  }).catch(stopOn);
  try {
    const { pin, members } = buildCast(extracted.inventory, deps.voices);
    saveCast(deps.db, plan.bookId, pin, members);
  } catch (err) {
    if (err instanceof CastingPausedError) throw new GenerateError(`casting stopped: ${err.message}`);
    throw err;
  }
  const cast = loadCast(deps.db, plan.bookId)!;
  deps.log(`cast: ${cast.characters.length} characters, ${cast.characters.filter((c) => c.voiceId).length} with voices`);
  return cast;
}

async function scriptFor(plan: BookPlan, e: PlannedEpisode, cast: StoredCast, deps: GenerateDeps): Promise<{ script: Script } | { failed: string }> {
  const stored = loadValidScript(deps.db, e.chapterId);
  if (stored) return { script: ScriptSchema.parse(stored.script) };
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
    ...(deps.delay ? { delay: deps.delay } : {}),
  }).catch(stopOn);
  saveAdaptation(deps.db, e.chapterId, {
    status: outcome.status === "valid" ? "adapted" : "failed",
    ...(outcome.status === "failed" ? { message: outcome.message } : {}),
    providerId: outcome.providerId,
    attempts: outcome.attempts.map(storedAttempt),
  });
  if (outcome.status === "failed") return { failed: `adaptation failed (${outcome.reason}): ${outcome.message}` };
  deps.log(`episode ${e.episodeNumber}: script valid (fidelity ${outcome.report.fidelity?.toFixed(2) ?? "n/a"}, ${outcome.attempts.length} attempt(s))`);
  return { script: outcome.script };
}

async function renderAndMix(plan: BookPlan, e: PlannedEpisode, script: Script, cast: StoredCast, cache: RenderCache, deps: GenerateDeps): Promise<{ durationMs: number } | { failed: string }> {
  const lines = speechLines(script, cast);
  const estimate = await planRender(cache, lines);
  if (estimate.problems.length > 0) return { failed: `speech cannot be rendered: ${estimate.problems.map((p) => `${p.id}: ${p.message}`).join("; ")}` };
  deps.log(`episode ${e.episodeNumber}: ${lines.length} lines, ${estimate.toRenderChars} of ${estimate.totalChars} characters to render (about ${Math.ceil(estimate.estimatedRenderMs / 60_000)} min)`);
  let done = 0;
  const outcomes = await renderSegments(lines, {
    cache,
    onSegment: () => {
      done++;
      if (done % 10 === 0 || done === lines.length) deps.log(`episode ${e.episodeNumber}: ${done}/${lines.length} lines rendered`);
    },
  }).catch(stopOn);
  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0) return { failed: `${failed.length} line(s) failed to render (first: ${failed[0]!.status === "failed" ? failed[0]!.error.message : ""}); run again to retry` };
  const speech = new Map<string, AudioFile>(outcomes.flatMap((o) => (o.status === "failed" ? [] : [[o.id, { path: o.result.path, frames: o.result.info.frames }] as const])));

  const outDir = join(deps.publicDir, "episodes", e.stationId);
  await mkdir(outDir, { recursive: true });
  const workDir = await mkdtemp(join(tmpdir(), "mr-mix-"));
  try {
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
    deps.db
      .prepare(
        `INSERT INTO episodes (id, chapter_id, mp3_path, clean_mp3_path, vtt_path, duration_ms, lufs, true_peak, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(chapter_id) DO UPDATE SET mp3_path = excluded.mp3_path, clean_mp3_path = excluded.clean_mp3_path, vtt_path = excluded.vtt_path,
           duration_ms = excluded.duration_ms, lufs = excluded.lufs, true_peak = excluded.true_peak, stale = 0`,
      )
      .run(e.stationId, e.chapterId, out.am.path, out.clean.path, out.vttPath, out.clean.durationMs, out.clean.integratedLufs, out.clean.truePeakDbtp);
    return { durationMs: out.clean.durationMs };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Run the whole flow for the chosen chapters. Per-episode failures are reported and the run goes on; budget and access problems stop it. */
export async function generateBook(plan: BookPlan, opts: GenerateOptions, deps: GenerateDeps): Promise<EpisodeResult[]> {
  const episodes = selected(plan, opts);
  if (episodes.length === 0) throw new GenerateError("no chapters selected");
  storeBook(deps.db, plan, opts.charBudget);
  const cast = await castBook(plan, deps);
  const cache = new RenderCache({
    dir: deps.cacheDir,
    provider: deps.tts,
    around: (info, call) => deps.ledger.withReservation({ bookId: plan.bookId, ttsChars: info.chars }, async () => ({ value: await call(), usage: { ttsChars: info.chars } })),
  });
  const stationsPath = join(deps.publicDir, "stations.json");
  const results: EpisodeResult[] = [];
  for (const e of episodes) {
    const base = { stationId: e.stationId, episodeNumber: e.episodeNumber, title: e.title };
    const finished = finishedEpisode(deps.db, e.chapterId, deps.publicDir, e.stationId);
    let result: EpisodeResult;
    if (finished) {
      result = { ...base, status: "ready", durationMs: finished.durationMs, reused: true };
    } else {
      const s = await scriptFor(plan, e, cast, deps);
      const mixed = "failed" in s ? s : await renderAndMix(plan, e, s.script, cast, cache, deps);
      result = "failed" in mixed ? { ...base, status: "failed", reason: mixed.failed } : { ...base, status: "ready", durationMs: mixed.durationMs, reused: false };
    }
    results.push(result);
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
      await mkdir(deps.publicDir, { recursive: true });
      await writeStations(stationsPath, mergeStations(await readStations(stationsPath), [station]));
      deps.log(`episode ${e.episodeNumber}: ${result.reused ? "already on air" : "on air"} as ${e.stationId} (${(result.durationMs / 60_000).toFixed(1)} min)`);
    } else {
      deps.log(`episode ${e.episodeNumber}: not produced: ${result.reason}`);
    }
  }
  return results;
}
