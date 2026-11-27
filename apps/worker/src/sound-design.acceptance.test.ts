import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ScriptSchema, StationListSchema, checkSpeechUnchanged } from "@midnight-radio/core";
import { BudgetLedger, currentRevision, currentSnapshot, getProgress, libraryLockHolder, listRevisions, listScripts, openDb, type BudgetConfig } from "@midnight-radio/db";
import { ingestEpub } from "@midnight-radio/ingest";
import { buildEpub } from "@midnight-radio/ingest/src/test-support/build-epub.js";
import type { StubLlmProvider } from "@midnight-radio/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIBRARY_LOCK } from "./generate/library.js";
import { storeBook } from "./generate/pipeline.js";
import { planBook, type BookPlan } from "./generate/plan.js";
import type { EpisodeReport } from "./generate/sound-episode.js";
import { stubLlm } from "./generate/stub-llm.js";
import { speechSpy, voiceDeps } from "./generate/test-support.js";
import { fakeSfxServer, writeSourceLibrary, type FakeSfxServer } from "./generate/test-support/fake-sfx.js";
import { EPISODE_JOB, SOUND_DESIGN_JOB, createHandlers, uploadPathFor, type GenerationServices } from "./handlers.js";
import { JobQueue } from "./jobs/queue.js";
import { runOnce } from "./jobs/runner.js";

/**
 * Acceptance tests for sound design as a supported, resumable workflow: the real queue, runner,
 * database, library stage, pipeline and ffmpeg, with the offline model, the stub voices and a fake
 * sound-effect server. No paid API is called.
 */

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");

const FILLER = "A match flared in the dark hall. The rain beat on the roof of the old house while the wind moved in the trees. Somewhere below, a door knocked three times, and nobody answered it.";
const epub = () =>
  buildEpub({
    title: "Test Gothic",
    author: "A. Writer",
    docs: [{ id: "c1", href: "c1.xhtml", body: `<h2>The Hall</h2><p>${FILLER}</p><p>\u201cWho is there?\u201d asked the Count.</p><p>\u201cOnly the rain,\u201d said Jonathan.</p>` }],
    toc: [{ label: "The Hall", href: "c1.xhtml" }],
  });
const BUDGET: BudgetConfig = { dailyTtsChars: 1_000_000, dailyLlmTokens: 10_000_000, bookTtsCharCeiling: 100_000 };
const CUES = [
  { id: "match_strike", prompt: "A match strikes and flares.", durationSec: 1, seed: 10, loopable: false },
  { id: "rain_bed", prompt: "Steady rain bed on a roof.", durationSec: 4, seed: 30, loopable: true },
];

describe.skipIf(!hasFfmpeg)("sound design workflow (acceptance)", () => {
  let dir: string;
  let db: DatabaseSync;
  let queue: JobQueue;
  let plan: BookPlan;
  let services: GenerationServices;
  let tts: ReturnType<typeof speechSpy>;
  let llm: StubLlmProvider;
  let server: FakeSfxServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-sound-"));
    db = openDb(join(dir, "mr.db"));
    queue = new JobQueue(db, { leaseMs: 60_000 });
    const bytes = new Uint8Array(await epub());
    plan = planBook(await ingestEpub(bytes), bytes);
    storeBook(db, plan, 50_000);
    const uploadsDir = join(dir, "uploads");
    await mkdir(uploadsDir);
    await writeFile(uploadPathFor(uploadsDir, plan.bookId), bytes);
    const sourceDir = join(dir, "assets/sfx");
    await writeSourceLibrary(sourceDir, CUES);
    const sourceCatalogue = JSON.parse(await readFile(join(sourceDir, "index.json"), "utf8"));
    tts = speechSpy();
    llm = stubLlm();
    server = fakeSfxServer();
    const v = await voiceDeps(dir);
    services = {
      llm,
      ttsFor: tts.ttsFor,
      designer: v.designerFn,
      series: v.series,
      seriesDir: v.seriesDir,
      designPin: v.designPin,
      voicesRoot: v.voicesRoot,
      sfx: sourceCatalogue,
      sfxDir: sourceDir,
      styleGuide: "# Style",
      cacheDir: join(dir, "cache"),
      broadcastDir: join(dir, "broadcast"),
      uploadsDir,
      library: { root: join(dir, "sfx-library"), sourceDir, musicDir: join(dir, "music-candidates"), connect: server.connect, takesPerCue: 2 },
      log: () => {},
      ff: { log: () => {} },
      delay: async () => undefined,
    };
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (extra: Partial<GenerationServices> = {}) => {
    const errors: unknown[] = [];
    await runOnce({ queue, handlers: createHandlers({ db, queue, ledger: new BudgetLedger(db, BUDGET), generation: { ...services, ...extra } }), heartbeatMs: 20, onError: (e) => errors.push(e) });
    return errors;
  };
  const chapter = () => plan.episodes[0]!.chapterId;
  const station = () => {
    const s = StationListSchema.parse(JSON.parse(readFileSync(join(dir, "broadcast/stations.json"), "utf8"))).stations[0]!;
    if (s.status !== "ready") throw new Error("station not ready");
    return s;
  };
  const report = (revisionDir: string) => JSON.parse(readFileSync(join(revisionDir, "report.json"), "utf8")) as EpisodeReport;

  it("prepares an empty library before adaptation, then publishes a verified revision with its report", async () => {
    const job = queue.enqueue(EPISODE_JOB, chapter(), { soundDesign: true });
    expect(await run()).toEqual([]);
    expect(queue.get(job.id)!.state).toBe("done");
    // The library was built first, and the adaptation prompt offered its sounds.
    expect(server.renders).toHaveLength(4);
    const adaptation = llm.requests.find((r) => r.jsonSchema.name === "radio_script")!;
    expect(adaptation.user).toContain("match_strike");
    expect(adaptation.user).toContain("sfx:rain_bed");
    const snap = currentSnapshot(db)!;
    expect(listScripts(db, chapter()).at(-1)).toMatchObject({ status: "valid", sfxSnapshotId: snap.id, origin: "adaptation" });
    // Progress per stage.
    const p = getProgress(db, job.id);
    expect([p.library?.state, p.script?.state, p.speech?.state, p.mix?.state]).toEqual(["done", "done", "done", "done"]);
    // A verified revision on air, with a report of what is really in it.
    const rev = currentRevision(db, chapter())!;
    expect(rev).toMatchObject({ revision: 1, snapshotId: snap.id });
    for (const f of ["episode.mp3", "episode-am.mp3", "episode.vtt", "report.json"]) expect(existsSync(join(rev.dir, f)), f).toBe(true);
    const r = report(rev.dir);
    expect(r.verification.clean.durationMs).toBeGreaterThan(5_000);
    expect(Math.abs(r.verification.clean.integratedLufs + 16)).toBeLessThanOrEqual(1);
    expect(r.verification.clean.truePeakDbtp).toBeLessThanOrEqual(-1);
    expect(r.verification.transcriptCues).toBeGreaterThan(0);
    expect(r.sounds.filter((s) => s.kind === "music").map((s) => s.id)).toContain("theme_test");
    expect(r.sounds.every((s) => /^[0-9a-f]{64}$/.test(s.sha256) && s.licence === "CC0-1.0")).toBe(true);
    expect(station()).toMatchObject({ cleanUrl: `/broadcast/episodes/${plan.episodes[0]!.stationId}/r1/episode.mp3`, vttUrl: `/broadcast/episodes/${plan.episodes[0]!.stationId}/r1/episode.vtt` });
  }, 180_000);

  it("remixes a saved episode with sounds, without changing speech or calling the speech service, keeping the old revision", async () => {
    queue.enqueue(EPISODE_JOB, chapter(), { soundDesign: true });
    expect(await run()).toEqual([]);
    const ttsBefore = tts.requests.length;
    const rendersBefore = server.renders.length;
    const first = currentRevision(db, chapter())!;

    const remix = queue.enqueue(SOUND_DESIGN_JOB, chapter());
    expect(await run()).toEqual([]);
    expect(queue.get(remix.id)!.state).toBe("done");
    expect(tts.requests.length).toBe(ttsBefore); // zero TTS calls: every line came from the cache
    expect(server.renders.length).toBe(rendersBefore); // the warm library was reused

    const [parent, child] = listScripts(db, chapter()).filter((s) => s.status === "valid").slice(-2) as [never, never] as [{ id: string; script: unknown }, { parentId: string; origin: string; script: unknown }];
    expect(child).toMatchObject({ origin: "sound_design", parentId: parent.id });
    const before = ScriptSchema.parse(parent.script);
    const after = ScriptSchema.parse(child.script);
    expect(checkSpeechUnchanged(before, after)).toEqual([]);
    expect(after.scenes[0]!.segments[0]).toEqual({ kind: "sfx", sfxId: "match_strike" });
    expect(after.scenes[0]!.ambience).toMatchObject({ id: "rain_bed" });

    const second = currentRevision(db, chapter())!;
    expect(second.revision).toBe(2);
    expect(existsSync(join(first.dir, "episode.mp3"))).toBe(true); // the previous revision is still there
    const r = report(second.dir);
    expect(r.speech).toMatchObject({ rendered: 0 });
    expect(r.sounds.find((s) => s.id === "match_strike")).toMatchObject({ kind: "sfx", licence: "CC0-1.0", source: { type: "generated", model: "test-sfx" } });
    expect(r.beds.map((b) => b.id)).toEqual(["rain_bed"]);
    expect(r.soundDesign!.added).toHaveLength(1);
    expect(station().cleanUrl).toMatch(/\/r2\/episode\.mp3$/);
  }, 180_000);

  it("keeps the previous revision on air when a remix fails", async () => {
    queue.enqueue(EPISODE_JOB, chapter(), { soundDesign: true });
    expect(await run()).toEqual([]);
    const first = currentRevision(db, chapter())!;
    const urlBefore = station().cleanUrl;
    const scriptsBefore = listScripts(db, chapter()).length;
    // The library on disk is damaged and no sound-effect server is reachable to rebuild it.
    const snap = currentSnapshot(db)!;
    await writeFile(join(snap.dir, "foley/match_strike.wav"), "damaged");
    const remix = queue.enqueue(SOUND_DESIGN_JOB, chapter());
    await run({ library: { ...services.library, connect: null } });
    expect(queue.get(remix.id)).toMatchObject({ state: "failed", error: expect.stringMatching(/SFX_SERVICE_URL/) });
    expect(currentRevision(db, chapter())!.id).toBe(first.id);
    expect(listRevisions(db, chapter())).toHaveLength(1);
    expect(station().cleanUrl).toBe(urlBefore);
    expect(existsSync(join(first.dir, "episode.mp3"))).toBe(true);
    expect(listScripts(db, chapter())).toHaveLength(scriptsBefore);
    expect(getProgress(db, remix.id).library?.state).toBe("failed");
  }, 180_000);

  it("stops a cancelled job during the library build, then resumes without rendering a take twice", async () => {
    const job = queue.enqueue(EPISODE_JOB, chapter(), { soundDesign: true });
    let cancelled = false;
    server.onRender = async () => {
      if (cancelled) return;
      cancelled = true;
      queue.requestCancel(job.id);
      await new Promise((r) => setTimeout(r, 200)); // the next heartbeat sees it
    };
    await run();
    expect(queue.get(job.id)).toMatchObject({ state: "failed", error: "cancelled by a person" });
    expect(currentSnapshot(db)).toBeUndefined();
    expect(libraryLockHolder(db, LIBRARY_LOCK, Date.now())).toBeNull();
    expect(listRevisions(db, chapter())).toHaveLength(0);
    delete server.onRender;
    const again = queue.enqueue(EPISODE_JOB, chapter(), { soundDesign: true });
    expect(await run()).toEqual([]);
    expect(queue.get(again.id)!.state).toBe("done");
    expect(new Set(server.renders).size).toBe(4);
    expect(server.renders).toHaveLength(4); // the take whose answer was lost was collected, not rendered again
  }, 180_000);

  it("runs a job queued without options exactly as before: no library stage, files in the station folder", async () => {
    const job = queue.enqueue(EPISODE_JOB, chapter());
    expect(await run()).toEqual([]);
    expect(queue.get(job.id)!.state).toBe("done");
    expect(server.requests).toHaveLength(0);
    expect(getProgress(db, job.id)).toEqual({});
    expect(listRevisions(db, chapter())).toHaveLength(0);
    expect(existsSync(join(dir, "broadcast/episodes", plan.episodes[0]!.stationId, "episode.mp3"))).toBe(true);
    expect(station().cleanUrl).toBe(`/broadcast/episodes/${plan.episodes[0]!.stationId}/episode.mp3`);
  }, 180_000);
});
