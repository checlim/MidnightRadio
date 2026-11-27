import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptSchema, applySoundDesign, checkSpeechUnchanged, stripUnavailableSound, validateCues, type Script } from "@midnight-radio/core";
import { currentRevision, loadValidScript, nextRevisionNumber, writeRevision, writeSoundDesignRevision, type ProgressStage, type StoredCast, type StoredScript } from "@midnight-radio/db";
import { SoundDesignError, proposeSoundDesign } from "@midnight-radio/llm";
import { mixEpisode, soundReport, verifyEpisode } from "@midnight-radio/mix";
import type { LibraryProgress, PreparedLibrary } from "./library.js";
import { GenerateError, adaptEpisode, jobFields, publishOf, putOnAir, renderSpeech, stopOn, type EpisodeResult, type GenerateDeps } from "./pipeline.js";
import type { BookPlan, PlannedEpisode } from "./plan.js";

/**
 * An episode with sound design: prepare the sound library, write (or add sounds to) the Script
 * against that library, check its cues, render or reuse speech, mix, verify the files, and only
 * then publish them as a new revision. Each stage reports its own progress.
 *
 * `generate` adapts a chapter with no Script yet using the ready library; a saved Script that was
 * not checked against this library gets a sound-design pass instead of a new adaptation.
 * `remix` always runs the sound-design pass on the saved Script and remixes it: speech is not
 * re-adapted, and identical lines come from the render cache, so a remix of fully cached speech
 * makes no speech-service call. In both, the pass may only add sound effects and set
 * backgrounds; `checkSpeechUnchanged` enforces that every spoken line, speaker and delivery stays.
 *
 * Revisions: each verified mix goes to `episodes/<station>/r<N>/` and is put on air only after
 * every check passed. Earlier revisions (and the legacy files in the station folder) stay where
 * they are, so a failed remix leaves the previous episode playing.
 */

export interface SoundDesignRun {
  mode: "generate" | "remix";
  library: () => Promise<PreparedLibrary>;
  progress: (stage: ProgressStage, p: LibraryProgress) => void;
}

export interface EpisodeReport {
  version: 1;
  revision: number;
  scriptId: string;
  parentScriptId: string | null;
  snapshotId: string;
  library: { reused: boolean; outOfDate: boolean; omitted: { id: string; reason: string }[] };
  soundDesign: {
    added: { path: string; sfxId: string; evidence: string }[];
    beds: { sceneIdx: number; id: string; evidence: string }[];
    /** Proposals the code refused, with why (optional sounds: the episode is made without them). */
    rejected: { edit: string; index: number; reason: string }[];
    /** Sounds the saved Script had that the library no longer offers. */
    removed: { path: string; id: string; reason: string }[];
  } | null;
  speech: { lines: number; rendered: number; cached: number };
  sounds: ReturnType<typeof soundReport>["sounds"];
  beds: ReturnType<typeof soundReport>["beds"];
  verification: Awaited<ReturnType<typeof verifyEpisode>>;
  voices: string;
}

export type SoundEpisodeResult = EpisodeResult & { report?: EpisodeReport };

interface DesignedScript {
  script: Script;
  scriptId: string;
  parentId: string | null;
  design: EpisodeReport["soundDesign"];
}

/** The sound-design pass on a saved Script: new revision stored, speech checked unchanged. */
async function designSaved(plan: BookPlan, e: PlannedEpisode, stored: StoredScript, lib: PreparedLibrary, deps: GenerateDeps): Promise<DesignedScript> {
  if (!deps.llm) throw new GenerateError("sound design needs the LLM (LLM_API_KEY) to place sounds in the saved Script");
  const parent = ScriptSchema.parse(stored.script);
  const base = stripUnavailableSound(parent, lib.catalogue);
  deps.log(`episode ${e.episodeNumber}: placing sounds in the saved Script (version ${stored.version}) from library ${lib.snapshotId}`);
  const proposal = await proposeSoundDesign({
    provider: deps.llm,
    ledger: deps.ledger,
    bookId: plan.bookId,
    chapterId: e.chapterId,
    script: base.script,
    chapterText: e.part.canonicalText,
    sfx: lib.catalogue,
    ...jobFields(deps),
    ...(deps.delay ? { delay: deps.delay } : {}),
  }).catch((err: unknown) => {
    if (err instanceof SoundDesignError) throw new GenerateError(`sound design failed: ${err.message}`);
    return stopOn(err);
  });
  const applied = applySoundDesign(base.script, proposal.edits, lib.catalogue, e.part.canonicalText);
  const changed = checkSpeechUnchanged(parent, applied.script);
  if (changed.length > 0) throw new GenerateError(`sound design changed the spoken Script (${changed.map((i) => `${i.path}: ${i.message}`).join("; ")}); nothing was saved`);
  const design = { added: applied.cues, beds: applied.beds, rejected: applied.rejected, removed: base.removed };
  const validation = { origin: "sound_design", providerId: proposal.providerId, requestId: proposal.requestId ?? null, snapshotId: lib.snapshotId, ...design };
  const written = publishOf(deps)((db) => writeSoundDesignRevision(db, e.chapterId, { parentId: stored.id, script: applied.script, validation, fidelity: stored.fidelity, sfxSnapshotId: lib.snapshotId }));
  for (const r of applied.rejected) deps.log(`episode ${e.episodeNumber}: proposed ${r.edit} ${r.index} left out (${r.reason})`);
  deps.log(`episode ${e.episodeNumber}: ${applied.cues.length} sound(s) and ${applied.beds.length} background(s) added, ${applied.rejected.length} proposal(s) left out`);
  return { script: applied.script, scriptId: written.id, parentId: stored.id, design };
}

export async function produceSoundDesigned(plan: BookPlan, e: PlannedEpisode, cast: StoredCast, deps: GenerateDeps, run: SoundDesignRun): Promise<SoundEpisodeResult> {
  const base = { stationId: e.stationId, episodeNumber: e.episodeNumber, title: e.title };
  for (const stage of ["script", "speech", "mix"] as const) run.progress(stage, { state: "pending", done: 0, total: 0, message: null });
  const fail = (stage: ProgressStage, message: string) => run.progress(stage, { state: "failed", message: message.slice(0, 300) });
  let stage: ProgressStage = "library";
  try {
    const lib = await run.library();

    // The Script, checked against this library.
    stage = "script";
    run.progress("script", { state: "running", message: "writing the Script against the sound library" });
    const stored = loadValidScript(deps.db, e.chapterId);
    let designed: DesignedScript;
    if (!stored) {
      if (run.mode === "remix") throw new GenerateError("this episode has no saved Script to add sounds to; generate it first");
      const adapted = await adaptEpisode(plan, e, cast, deps, { catalogue: lib.catalogue, snapshotId: lib.snapshotId });
      if ("failed" in adapted) {
        fail("script", adapted.failed);
        return { ...base, status: "failed", reason: adapted.failed };
      }
      designed = { ...adapted, parentId: null, design: null };
    } else if (run.mode === "generate" && stored.sfxSnapshotId === lib.snapshotId) {
      designed = { script: ScriptSchema.parse(stored.script), scriptId: stored.id, parentId: stored.parentId, design: null };
    } else {
      designed = await designSaved(plan, e, stored, lib, deps);
    }
    const cueIssues = validateCues(lib.catalogue, designed.script);
    if (cueIssues.length > 0) throw new GenerateError(`the Script's sounds do not fit sound library ${lib.snapshotId}: ${cueIssues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    run.progress("script", { state: "done", message: designed.design ? `${designed.design.added.length} sound(s) added` : "Script ready" });

    // Already on air from this Script and library: nothing to do.
    const onAir = currentRevision(deps.db, e.chapterId);
    if (run.mode === "generate" && onAir && onAir.scriptId === designed.scriptId && onAir.snapshotId === lib.snapshotId && existsSync(join(onAir.dir, "episode.mp3"))) {
      for (const s of ["speech", "mix"] as const) run.progress(s, { state: "skipped", message: "already on air" });
      deps.log(`episode ${e.episodeNumber}: already on air (revision ${onAir.revision})`);
      return { ...base, status: "ready", durationMs: onAir.durationMs, reused: true };
    }

    // Speech: identical lines come from the render cache.
    stage = "speech";
    run.progress("speech", { state: "running", message: "rendering speech" });
    const voiced = await renderSpeech(plan, e, designed.script, designed.scriptId, cast, deps, (done, total) => run.progress("speech", { state: "running", done, total }));
    if ("failed" in voiced) {
      fail("speech", voiced.failed);
      return { ...base, status: "failed", reason: voiced.failed };
    }
    run.progress("speech", { state: "done", done: voiced.lines, total: voiced.lines, message: `${voiced.rendered} rendered, ${voiced.cached} from the cache` });

    // Mix into a staging folder, verify, then publish as a new revision.
    stage = "mix";
    run.progress("mix", { state: "running", message: "mixing and mastering" });
    const revision = nextRevisionNumber(deps.db, e.chapterId);
    const stationDir = join(deps.broadcastDir, "episodes", e.stationId);
    const finalDir = join(stationDir, `r${revision}`);
    const staging = join(stationDir, `.r${revision}-${randomBytes(6).toString("hex")}`);
    await mkdir(staging, { recursive: true });
    const workDir = await mkdtemp(join(tmpdir(), "mr-mix-"));
    try {
      deps.fence?.();
      const out = await mixEpisode(
        {
          script: designed.script,
          speech: voiced.speech,
          sfx: lib.catalogue,
          sfxDir: lib.dir,
          workDir,
          outDir: staging,
          tags: {
            title: `Episode ${e.episodeNumber}: ${e.title}`,
            album: `Midnight Radio: ${plan.title}`,
            artist: plan.author ?? "Unknown author",
            track: e.episodeNumber,
            aiDisclosure: `AI-generated radio adaptation: script by a language model from the book's text, voices by ${voiced.tts.identity.model}.`,
          },
        },
        deps.ff,
      );
      run.progress("mix", { state: "running", message: "verifying the episode" });
      const verification = await verifyEpisode({ cleanPath: out.clean.path, amPath: out.am.path, vttPath: out.vttPath }, out.timeline, deps.ff ?? {});
      const placed = soundReport(out.timeline, lib.catalogue);
      const report: EpisodeReport = {
        version: 1,
        revision,
        scriptId: designed.scriptId,
        parentScriptId: designed.parentId,
        snapshotId: lib.snapshotId,
        library: { reused: lib.reused, outOfDate: lib.outOfDate, omitted: lib.report.foley.omitted },
        soundDesign: designed.design,
        speech: { lines: voiced.lines, rendered: voiced.rendered, cached: voiced.cached },
        sounds: placed.sounds,
        beds: placed.beds,
        verification,
        voices: voiced.tts.identity.model,
      };
      await writeFile(join(staging, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      deps.fence?.();
      if (existsSync(finalDir)) await rm(finalDir, { recursive: true, force: true }); // left by a run that stopped before recording it
      await rename(staging, finalDir);
      const files = { mp3: join(finalDir, "episode-am.mp3"), cleanMp3: join(finalDir, "episode.mp3"), vtt: join(finalDir, "episode.vtt"), stationId: e.stationId };
      publishOf(deps)((db) =>
        writeRevision(
          db,
          { id: randomUUID(), chapterId: e.chapterId, revision, scriptId: designed.scriptId, snapshotId: lib.snapshotId, dir: finalDir, report, durationMs: verification.clean.durationMs, lufs: verification.clean.integratedLufs, truePeak: verification.clean.truePeakDbtp },
          files,
          Date.now(),
        ),
      );
      await putOnAir(plan, e, verification.clean.durationMs, `/broadcast/episodes/${e.stationId}/r${revision}`, deps);
      run.progress("mix", { state: "done", message: `revision ${revision} on air: ${placed.sounds.filter((s) => s.kind === "sfx").length} sound effect(s), ${placed.beds.length} background(s)` });
      deps.log(`episode ${e.episodeNumber}: revision ${revision} on air as ${e.stationId} (${(verification.clean.durationMs / 60_000).toFixed(1)} min, ${voiced.rendered} line(s) rendered, ${voiced.cached} from the cache)`);
      return { ...base, status: "ready", durationMs: verification.clean.durationMs, reused: false, report };
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  } catch (err) {
    fail(stage, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
