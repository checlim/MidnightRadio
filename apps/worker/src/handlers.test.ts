import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { STUB_VOICE_CATALOGUE, StationListSchema, checkAdaptationReply, validateScript, type SfxCatalogue } from "@midnight-radio/core";
import { BudgetLedger, editCastVoices, loadCast, openDb, type BudgetConfig } from "@midnight-radio/db";
import { ingestEpub } from "@midnight-radio/ingest";
import { buildEpub } from "@midnight-radio/ingest/src/test-support/build-epub.js";
import { SERIES_TITLE, StubLlmProvider, buildAdaptationPrompt } from "@midnight-radio/llm";
import { encodeWav, type SynthesisRequest } from "@midnight-radio/tts";
import { speechSpy, voiceDeps } from "./generate/test-support.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validationCast } from "./generate/cast-lines.js";
import { storeBook } from "./generate/pipeline.js";
import { planBook, type BookPlan } from "./generate/plan.js";
import { STUB_CHARACTER, stubAdaptation, stubLlm } from "./generate/stub-llm.js";
import { EPISODE_JOB, createHandlers, uploadPathFor, type GenerationServices } from "./handlers.js";
import { JobQueue } from "./jobs/queue.js";
import { runOnce } from "./jobs/runner.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");

const RATE = 24_000;
const FILLER =
  "The night was cold and the road was long. The carriage climbed between dark pines while the wind moved in the branches above. Far below, a river ran black under the moon, and the driver said nothing at all. Every mile the hills grew steeper and the sky grew lower, until the stars were hidden and only the lamps showed the way. At last the walls of an old castle rose out of the dark.";
const epub = () =>
  buildEpub({
    title: "Test Gothic",
    author: "A. Writer",
    docs: [
      { id: "c1", href: "c1.xhtml", body: `<h2>The Door</h2><p>${FILLER}</p><p>\u201cWelcome to my house!\u201d said the Count.</p><p>\u201cCount Dracula?\u201d Jonathan asked.</p>` },
      { id: "c2", href: "c2.xhtml", body: `<h2>The Letter</h2><p>${FILLER}</p><p>Mina wrote: \u201cI am waiting for you.\u201d</p>` },
    ],
    toc: [
      { label: "The Door", href: "c1.xhtml" },
      { label: "The Letter", href: "c2.xhtml" },
    ],
  });
const BUDGET: BudgetConfig = { dailyTtsChars: 1_000_000, dailyLlmTokens: 10_000_000, bookTtsCharCeiling: 100_000 };

describe("handlers registry", () => {
  it("registers no generation job while generation is disabled", () => {
    const db = openDb(":memory:");
    try {
      expect(createHandlers({ db, queue: new JobQueue(db), ledger: new BudgetLedger(db, BUDGET) })).toEqual({});
    } finally {
      db.close();
    }
  });
});

describe("the offline stand-in model", () => {
  const fixture = (file: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "../../../fixtures/books", file)));

  it("adapts the demo chapters so that they pass the real fidelity gate", async () => {
    const sfx: SfxCatalogue = { version: 1, id: "lib", entries: [{ id: "theme_x", kind: "music", title: "Theme", path: "music/t.wav", sha256: "a".repeat(64), durationMs: 3000, loopable: false, peakDb: -1, tags: [], source: { type: "project", author: "x", licence: "CC0-1.0" } }], musicCues: { theme: "theme_x" } };
    const cast = [
      { name: "Announcer", role: "announcer" as const, speaks: true },
      { name: "Narrator", role: "narrator" as const, speaks: true },
      { name: STUB_CHARACTER, role: "character" as const, speaks: true },
    ];
    const check = async (file: string, chapterNumber: number) => {
      const bytes = fixture(file);
      const plan = planBook(await ingestEpub(bytes), bytes);
      const e = plan.episodes.find((x) => x.chapterNumber === chapterNumber)!;
      const input = {
        book: { title: plan.title, author: plan.author },
        chapter: { idx: e.chapter.idx, title: e.title, part: e.part.part, partCount: e.part.partCount, canonicalText: e.part.canonicalText },
        episodeNumber: e.episodeNumber,
        cast: [{ name: STUB_CHARACTER, aliases: [], genderPresentation: "unstated", description: null, speaks: true }],
        sfx,
        styleGuide: "# Style",
      };
      const reply = JSON.stringify(stubAdaptation(buildAdaptationPrompt(input).user));
      const episode = { bookId: plan.bookId, chapterId: e.chapterId, episodeNumber: e.episodeNumber, seriesTitle: SERIES_TITLE, chapterTitle: e.title, canonicalText: e.part.canonicalText };
      const checked = checkAdaptationReply(reply, episode);
      expect(checked.ok, JSON.stringify(checked.ok ? null : checked.issues.slice(0, 3))).toBe(true);
      if (!checked.ok) return;
      const report = validateScript({ script: checked.script, episode, sourceText: e.part.sourceText, canonicalText: e.part.canonicalText, quoteParse: e.quoteParse, quotes: e.quotes, cast, sfx });
      expect({ ok: report.ok, fidelity: report.fidelity }).toEqual({ ok: true, fidelity: 1 });
      return checked.script.scenes[0]!.segments.filter((s) => s.kind === "dialogue").length;
    };
    expect(await check("bram-stoker_dracula.epub", 1)).toBeGreaterThan(2);
    expect(await check("edgar-allan-poe_short-fiction.epub", 40)).toBeGreaterThan(2); // The Telltale Heart
  });
});

describe.skipIf(!hasFfmpeg)("episode job (stub model, stub voices, real ffmpeg, real queue)", () => {
  let dir: string;
  let db: DatabaseSync;
  let queue: JobQueue;
  let plan: BookPlan;
  let tts: { requests: SynthesisRequest[] };
  let services: GenerationServices;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-jobs-"));
    db = openDb(join(dir, "mr.db"));
    queue = new JobQueue(db, { leaseMs: 60_000 });
    const bytes = new Uint8Array(await epub());
    plan = planBook(await ingestEpub(bytes), bytes);
    storeBook(db, plan, 50_000);
    const uploadsDir = join(dir, "uploads");
    await mkdir(uploadsDir);
    await writeFile(uploadPathFor(uploadsDir, plan.bookId), bytes);
    const sfxDir = join(dir, "sfx");
    await mkdir(join(sfxDir, "music"), { recursive: true });
    await writeFile(join(sfxDir, "music/theme.wav"), encodeWav(Int16Array.from({ length: 2 * RATE }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 196 * i) / RATE) * Math.min(1, i / 2400, (2 * RATE - i) / 2400)))));
    const speech = speechSpy();
    tts = speech;
    const v = await voiceDeps(dir);
    services = {
      llm: stubLlm(),
      ttsFor: speech.ttsFor,
      designer: v.designerFn,
      series: v.series,
      seriesDir: v.seriesDir,
      designPin: v.designPin,
      voicesRoot: v.voicesRoot,
      sfx: { version: 1, id: "lib", entries: [{ id: "theme_x", kind: "music", title: "Theme", path: "music/theme.wav", sha256: "a".repeat(64), durationMs: 2000, loopable: false, peakDb: -1, tags: [], source: { type: "project", author: "x", licence: "CC0-1.0" } }], musicCues: { theme: "theme_x" } },
      sfxDir,
      styleGuide: "# Style",
      cacheDir: join(dir, "cache"),
      broadcastDir: join(dir, "public"),
      uploadsDir,
      library: { root: join(dir, "sfx-library"), sourceDir: sfxDir, musicDir: join(dir, "music"), connect: null },
      log: () => {},
      ff: { log: () => {} },
      delay: async () => undefined,
    };
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const run = async (ledger = new BudgetLedger(db, BUDGET), extra: Partial<GenerationServices> = {}) => {
    const errors: unknown[] = [];
    await runOnce({ queue, handlers: createHandlers({ db, queue, ledger, generation: { ...services, ...extra } }), onError: (e) => errors.push(e) });
    return errors;
  };
  const chapter1 = () => plan.episodes[0]!.chapterId;
  const stationIds = () => StationListSchema.parse(JSON.parse(readFileSync(join(dir, "public/stations.json"), "utf8"))).stations.map((s) => s.id);

  it("produces the episode, records its lines and its usage per chapter", async () => {
    const job = queue.enqueue(EPISODE_JOB, chapter1());
    expect(await run()).toEqual([]);
    expect(queue.get(job.id)!.state).toBe("done");
    expect(stationIds()).toEqual([plan.episodes[0]!.stationId]);
    const rows = db.prepare("SELECT kind, speaker, status, duration_ms AS ms, cache_key AS key FROM segments ORDER BY section, IFNULL(scene_idx, -1), idx").all() as { kind: string; speaker: string | null; status: string; ms: number | null; key: string | null }[];
    const spoken = rows.filter((r) => r.kind !== "music");
    expect(spoken.map((r) => [r.kind, r.speaker, r.status])).toEqual(expect.arrayContaining([["dialogue", STUB_CHARACTER, "rendered"]]));
    expect(spoken.every((r) => r.status === "rendered" && r.ms! > 0 && r.key)).toBe(true);
    const usage = db.prepare("SELECT chapter_id AS ch, SUM(llm_in) AS llm, SUM(tts_chars) AS tts FROM usage GROUP BY chapter_id ORDER BY chapter_id").all() as { ch: string | null; llm: number; tts: number }[];
    expect(usage.find((u) => u.ch === chapter1())).toMatchObject({ llm: expect.any(Number), tts: expect.any(Number) });
    expect(usage.find((u) => u.ch === chapter1())!.tts).toBe(tts.requests.reduce((n, r) => n + r.text.length, 0));
    expect(usage.find((u) => u.ch === null)!.llm).toBeGreaterThan(0); // casting is book-wide
  }, 120_000);

  it("after a Cast edit re-renders only the changed character's lines and re-mixes the episode", async () => {
    // Two speaking characters, each with a voice designed for them; The Stranger speaks every line.
    const base = stubLlm();
    const twoVoices = new StubLlmProvider(async (req, call) =>
      req.jsonSchema.name === "chunk_characters"
        ? JSON.stringify({ characters: [STUB_CHARACTER, "Mina"].map((name) => ({ name, aliases: [], genderPresentation: "unstated", ageBand: "adult", description: `${name} speaks.`, speaks: true })) })
        : (await base.complete(req)).text || String(call),
    );
    queue.enqueue(EPISODE_JOB, chapter1());
    expect(await run(undefined, { llm: twoVoices })).toEqual([]);
    const before = tts.requests.length;
    const cast = loadCast(db, plan.bookId)!;
    const stranger = cast.characters.find((c) => c.name === STUB_CHARACTER)!;
    const mina = cast.characters.find((c) => c.name === "Mina")!;
    expect(stranger.voiceId).not.toBe(mina.voiceId);
    const free = { id: mina.voiceId! };
    const edit = editCastVoices(db, plan.bookId, cast.pin, [
      { name: STUB_CHARACTER, voiceId: mina.voiceId!, voiceFit: "fair" },
      { name: "Mina", voiceId: stranger.voiceId!, voiceFit: "fair" },
    ]); // a swap: both are re-voiced, but only The Stranger has lines
    expect(edit).toMatchObject({ changed: [STUB_CHARACTER, "Mina"], segmentsInvalidated: 2, affectedChapterIds: [chapter1()] });
    expect(db.prepare("SELECT stale FROM episodes WHERE chapter_id = ?").get(chapter1())).toEqual({ stale: 1 });

    const job = queue.enqueue(EPISODE_JOB, chapter1());
    expect(await run()).toEqual([]);
    expect(queue.get(job.id)!.state).toBe("done");
    expect(tts.requests.slice(before).map((r) => [r.voiceId, r.text])).toEqual([
      [free.id, "Welcome to my house!"],
      [free.id, "Count Dracula?"],
    ]);
    expect(db.prepare("SELECT stale FROM episodes WHERE chapter_id = ?").get(chapter1())).toEqual({ stale: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM segments WHERE status != 'rendered' AND kind != 'music'").get()).toEqual({ n: 0 });
  }, 120_000);

  it("parks the job when a cap is reached, and fails it without retries when the problem will not go away", async () => {
    const parked = queue.enqueue(EPISODE_JOB, chapter1());
    await run(new BudgetLedger(db, { ...BUDGET, dailyLlmTokens: 10 }));
    expect(queue.get(parked.id)).toMatchObject({ state: "over_budget", error: expect.stringMatching(/GLOBAL_DAILY_LLM_TOKEN_LIMIT/) });
    db.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").run(parked.id);

    const bad = new StubLlmProvider((req) =>
      req.jsonSchema.name === "chunk_characters" ? JSON.stringify({ characters: [] }) : JSON.stringify({ coldOpen: [{ kind: "announcer", text: "Hello." }], scenes: [{ id: "s", segments: [{ kind: "narration", text: "x" }] }], close: [{ kind: "announcer", text: "Bye." }] }),
    );
    const failing = queue.enqueue(EPISODE_JOB, chapter1());
    await run(undefined, { llm: bad });
    expect(queue.get(failing.id)).toMatchObject({ state: "failed", attempts: 1, error: expect.stringMatching(/adaptation failed \(attempts_exhausted\)/) });

    await writeFile(uploadPathFor(services.uploadsDir, plan.bookId), new Uint8Array(await epub()).reverse());
    const changed = queue.enqueue(EPISODE_JOB, plan.episodes[1]!.chapterId);
    await run();
    expect(queue.get(changed.id)).toMatchObject({ state: "failed", attempts: 1, error: expect.stringMatching(/has changed since it was stored/) });
    db.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").run(changed.id);

    await rm(uploadPathFor(services.uploadsDir, plan.bookId));
    const missing = queue.enqueue(EPISODE_JOB, plan.episodes[1]!.chapterId);
    await run();
    expect(queue.get(missing.id)).toMatchObject({ state: "failed", attempts: 1, error: expect.stringMatching(/uploaded EPUB for this book is missing/) });
  }, 120_000);

  it("publishes nothing once another worker has taken the job over", async () => {
    const job = queue.enqueue(EPISODE_JOB, chapter1());
    const stolen = speechSpy((p) => {
      const synthesize = p.synthesize.bind(p);
      p.synthesize = async (req, opts) => {
        db.prepare("UPDATE jobs SET lease_token = 'another-worker' WHERE id = ?").run(job.id); // the lease was reclaimed elsewhere
        return synthesize(req, opts);
      };
      return p;
    });
    const started = Date.now();
    await run(undefined, { ttsFor: stolen.ttsFor });
    expect(Date.now() - started).toBeLessThan(3_000); // it let go at once, without retrying each remaining line (back-off starts at 1 s)
    expect(db.prepare("SELECT COUNT(*) AS n FROM episodes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM segments WHERE status = 'rendered'").get()).toEqual({ n: 0 });
    expect(existsSync(join(dir, "public/stations.json"))).toBe(false);
    expect(queue.get(job.id)!.state).toBe("running"); // left for its new owner
    expect(stolen.requests).toHaveLength(1); // rendering stopped at the next line instead of carrying on
  }, 120_000);

  it("retries when the local audio service is not ready", async () => {
    const job = queue.enqueue(EPISODE_JOB, chapter1());
    await run(undefined, {
      ttsFor: async () => {
        throw new Error("Qwen3-TTS is not ready: the local audio service is not running");
      },
    });
    expect(queue.get(job.id)).toMatchObject({ state: "queued", attempts: 1, error: expect.stringMatching(/not ready/) });
  });
});
