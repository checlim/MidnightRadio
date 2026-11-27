import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { SfxCatalogueSchema, type SfxCatalogue } from "@midnight-radio/core";
import {
  acquireLibraryLock,
  beginTake,
  currentSnapshot,
  deleteSnapshotRecord,
  failTake,
  finishTake,
  getTake,
  listSnapshots,
  publishSnapshot,
  reclaimOrphanTakes,
  releaseLibraryLock,
  renewLibraryLock,
  snapshotsInUse,
  type ProgressState,
  type SnapshotRecord,
} from "@midnight-radio/db";
import { AssembleError, autoAssemble, importMusic, type FfmpegOptions } from "@midnight-radio/mix";
import { SfxError, type SfxClient } from "@midnight-radio/tts";
import { z } from "zod";

/**
 * The library stage of a sound-designed job: make sure a ready, versioned sound library exists
 * before the Script is written, and say which one the job uses.
 *
 * The library is built from the committed inputs (`assets/sfx/prompts.json`, `music-sources.json`
 * and the committed `index.json` with its music) and foley takes generated on the sound-effect
 * server. Each build produces an immutable snapshot folder `<root>/snapshots/<catalogue id>`,
 * published atomically (folder renamed into place, then made current in the database). A job
 * mixes from the snapshot it was bound to, so a later build never changes the library under an
 * active mix; snapshots no unfinished job uses are removed after a build.
 *
 * One builder at a time (a database lock with a renewed lease, so it holds across processes). A
 * warm library, built from the same inputs and with every file matching its hash, is reused
 * without contacting the server. Takes are stored by key (a hash of the model, prompt, length,
 * seed and take number), which is also the Idempotency-Key, so a build that stopped part-way
 * resumes, and a request whose answer was lost is collected rather than rendered twice.
 */

export const LIBRARY_LOCK = "sfx-library";
export const LIBRARY_BUILD_VERSION = "library-1";

/** A reason the library cannot be prepared that retrying will not fix. The message says what to do. */
export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

export interface LibraryProgress {
  state: ProgressState;
  done?: number;
  total?: number;
  message?: string | null;
}

export interface LibraryDeps {
  db: DatabaseSync;
  /** `<DATA_DIR>/sfx-library`: takes/ and snapshots/. */
  root: string;
  /** `assets/sfx`: prompts.json, music-sources.json and the committed index.json with its files. */
  sourceDir: string;
  /** Downloaded CC0 music, used only if the committed library lacks a music cue. Never downloaded here. */
  musicDir: string;
  /** Connects to the sound-effect server; null when SFX_SERVICE_URL is not set. */
  connect: (() => Promise<SfxClient>) | null;
  /** Who builds (the job id). */
  holder: string;
  /** Bind the caller to the current snapshot (a job: `bindJobSnapshot` in its fenced publish). Returns the bound id. */
  bind: () => string | null;
  takesPerCue?: number;
  /** Requests per take within one build (each counted before it is sent). Default 3. */
  maxAttempts?: number;
  lockLeaseMs?: number;
  lockPollMs?: number;
  now?: () => number;
  log: (message: string) => void;
  progress?: (p: LibraryProgress) => void;
  signal?: AbortSignal;
  fence?: () => void;
  /** Tests only: accept takes from the local service's fake (tone) backend. */
  allowFakeModel?: boolean;
  ff?: FfmpegOptions;
}

export interface LibraryReport {
  version: string;
  inputsSha: string;
  model: { model: string; revision: string; weightsSha256: string | null; license: string } | null;
  takes: { generated: number; reused: number; failed: { cue: string; take: number; error: string }[] };
  foley: { assembled: string[]; omitted: { id: string; reason: string }[] };
  music: Record<string, string>;
}

export interface PreparedLibrary {
  snapshotId: string;
  dir: string;
  catalogue: SfxCatalogue;
  /** The snapshot was already there and was used as it is. */
  reused: boolean;
  /** The inputs changed but no server is configured, so the existing snapshot is used. */
  outOfDate: boolean;
  report: LibraryReport;
}

const PromptsSchema = z.object({ version: z.literal(1), cues: z.array(z.object({ id: z.string(), prompt: z.string(), durationSec: z.number(), seed: z.number().int(), loopable: z.boolean() }).passthrough()) });
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const readOptional = async (path: string) => (existsSync(path) ? readFile(path) : Buffer.alloc(0));

/** The hash of everything a build depends on, apart from the model (part of every take's key). */
export async function libraryInputsSha(sourceDir: string, takesPerCue: number): Promise<string> {
  const parts = await Promise.all(["prompts.json", "music-sources.json", "index.json"].map((f) => readOptional(join(sourceDir, f))));
  return sha256(JSON.stringify([LIBRARY_BUILD_VERSION, takesPerCue, ...parts.map((p) => sha256(p))]));
}

/** The take key: also the Idempotency-Key sent to the server. */
export const takeKey = (modelJson: string, cue: { prompt: string; durationSec: number; seed: number }, take: number) => sha256(JSON.stringify([modelJson, cue.prompt, cue.durationSec, cue.seed, take]));

/** Read a snapshot's catalogue and check every file against its hash. Null if anything is off. */
export async function verifySnapshot(dir: string, expectedId?: string): Promise<SfxCatalogue | null> {
  try {
    const catalogue = SfxCatalogueSchema.parse(JSON.parse(await readFile(join(dir, "index.json"), "utf8")));
    if (expectedId && catalogue.id !== expectedId) return null;
    for (const e of catalogue.entries) if (sha256(await readFile(join(dir, e.path))) !== e.sha256) return null;
    return catalogue;
  } catch {
    return null;
  }
}

async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

const inside = (root: string, path: string) => resolve(path).startsWith(resolve(root) + sep);

/** Prepare (or reuse) the sound library and bind the caller to it. */
export async function prepareLibrary(deps: LibraryDeps): Promise<PreparedLibrary> {
  const now = deps.now ?? Date.now;
  const takesPerCue = deps.takesPerCue ?? 3;
  const progress = deps.progress ?? (() => undefined);
  const inputs = await libraryInputsSha(deps.sourceDir, takesPerCue);
  progress({ state: "running", message: "checking the sound library" });

  /** The current snapshot if it is warm (same inputs, files intact), bound to the caller. */
  const warm = async (acceptOutOfDate: boolean): Promise<PreparedLibrary | null> => {
    for (let tries = 0; tries < 3; tries++) {
      const cur = currentSnapshot(deps.db);
      if (!cur || (cur.promptsSha !== inputs && !acceptOutOfDate)) return null;
      const catalogue = await verifySnapshot(cur.dir, cur.id);
      if (!catalogue) return null;
      deps.fence?.();
      if (deps.bind() !== cur.id) continue; // another build was published meanwhile: look again
      return { snapshotId: cur.id, dir: cur.dir, catalogue, reused: true, outOfDate: cur.promptsSha !== inputs, report: cur.report as LibraryReport };
    }
    return null;
  };

  const ready = await warm(false);
  if (ready) {
    progress({ state: "done", message: `sound library ${ready.snapshotId} is ready` });
    return ready;
  }
  if (!deps.connect) {
    const stale = await warm(true);
    if (stale) {
      deps.log(`sound library: the inputs changed but SFX_SERVICE_URL is not set, so ${stale.snapshotId} is used as it is`);
      progress({ state: "done", message: `using ${stale.snapshotId}; it is out of date (no sound-effect server configured)` });
      return stale;
    }
    throw new LibraryError("sound design needs a sound library and none has been built yet; set SFX_SERVICE_URL (and SFX_SERVICE_TOKEN for https) to a sound-effect server, then retry the job");
  }

  // One builder at a time. While another job builds, wait, then use its result if it fits.
  const leaseMs = deps.lockLeaseMs ?? 60_000;
  let waited = false;
  while (!acquireLibraryLock(deps.db, LIBRARY_LOCK, deps.holder, leaseMs, now())) {
    if (!waited) progress({ state: "running", message: "waiting for another job to finish building the sound library" });
    waited = true;
    await sleep(deps.lockPollMs ?? 2_000, undefined, { signal: deps.signal });
  }
  const lost = new AbortController();
  const renew = setInterval(() => {
    try {
      if (!renewLibraryLock(deps.db, LIBRARY_LOCK, deps.holder, leaseMs, now())) lost.abort(new Error("lost the sound-library lock"));
    } catch {
      // A busy database: the next tick tries again; the lease outlasts a few misses.
    }
  }, Math.max(10, Math.floor(leaseMs / 3)));
  const signal = deps.signal ? AbortSignal.any([deps.signal, lost.signal]) : lost.signal;
  try {
    if (waited) {
      const built = await warm(false);
      if (built) {
        progress({ state: "done", message: `sound library ${built.snapshotId} is ready` });
        return built;
      }
    }
    const result = await build(deps, { inputs, takesPerCue, signal, progress, now });
    await collectUnused(deps.db, deps.root);
    return result;
  } finally {
    clearInterval(renew);
    releaseLibraryLock(deps.db, LIBRARY_LOCK, deps.holder);
  }
}

async function build(deps: LibraryDeps, b: { inputs: string; takesPerCue: number; signal: AbortSignal; progress: (p: LibraryProgress) => void; now: () => number }): Promise<PreparedLibrary> {
  const prompts = PromptsSchema.parse(JSON.parse(await readFile(join(deps.sourceDir, "prompts.json"), "utf8")));
  let client: SfxClient;
  try {
    client = await deps.connect!();
  } catch (err) {
    if (err instanceof SfxError && err.kind === "fatal") throw new LibraryError(err.message);
    throw err;
  }
  const m = client.model;
  if (!deps.allowFakeModel && /^fake/i.test(m.model)) throw new LibraryError(`the sound-effect server runs "${m.model}", the local service's test backend (tones); point SFX_SERVICE_URL at a real sound-effect server`);
  const modelJson = JSON.stringify({ model: m.model, revision: m.revision, weightsSha256: m.weightsSha256, license: m.license, sampleRate: m.sampleRate });
  const takesDir = join(deps.root, "takes");
  await mkdir(takesDir, { recursive: true });
  reclaimOrphanTakes(deps.db, b.now());

  const total = prompts.cues.length * b.takesPerCue;
  let done = 0;
  let generated = 0;
  let reused = 0;
  const failed: LibraryReport["takes"]["failed"] = [];
  b.progress({ state: "running", done: 0, total, message: `generating foley on ${m.model}` });
  const maxAttempts = deps.maxAttempts ?? 3;
  const takeLeaseMs = 30 * 60_000;
  for (const cue of prompts.cues) {
    for (let n = 1; n <= b.takesPerCue; n++) {
      const seed = cue.seed + n - 1;
      const key = takeKey(modelJson, { prompt: cue.prompt, durationSec: cue.durationSec, seed }, n);
      const path = join(takesDir, `${key}.wav`);
      const existing = getTake(deps.db, key);
      if (existing?.state === "done" && existsSync(path) && sha256(await readFile(path)) === existing.sha256) {
        reused++;
        b.progress({ state: "running", done: ++done, total });
        continue;
      }
      if (existing?.state === "done") failTake(deps.db, key, "the stored file is missing or changed", b.now()); // render it again
      let lastError = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (b.signal.aborted) throw b.signal.reason;
        deps.fence?.();
        const claimed = beginTake(deps.db, { key, cueId: cue.id, take: n, prompt: cue.prompt, durationSec: cue.durationSec, seed, modelJson }, takeLeaseMs, b.now());
        if (!claimed) throw new Error(`take ${n} of ${cue.id} is claimed by another builder`);
        try {
          const bytes = await client.render({ prompt: cue.prompt, durationSec: cue.durationSec, seed }, { idempotencyKey: key, signal: b.signal });
          await writeAtomic(path, bytes);
          finishTake(deps.db, key, `${key}.wav`, sha256(bytes), b.now());
          generated++;
          lastError = "";
          break;
        } catch (err) {
          if (err instanceof SfxError && err.kind === "aborted") throw b.signal.reason ?? err; // left in flight: the next build collects it with the same key
          const message = err instanceof Error ? err.message : String(err);
          failTake(deps.db, key, message, b.now());
          if (err instanceof SfxError && err.kind === "fatal") throw new LibraryError(`sound-effect generation stopped: ${message}`);
          lastError = message;
          deps.log(`sound library: ${cue.id} take ${n}, attempt ${attempt} of ${maxAttempts} failed (${message})${err instanceof SfxError && err.kind === "uncertain" ? (m.idempotency ? "; asking again with the same key" : "; counted as an attempt") : ""}`);
        }
      }
      if (lastError) failed.push({ cue: cue.id, take: n, error: lastError });
      b.progress({ state: "running", done: ++done, total });
    }
  }
  deps.log(`sound library: ${generated} take(s) generated, ${reused} reused, ${failed.length} failed`);
  return assembleSnapshot(deps, b, { prompts, modelJson, model: m, takesDir, generated, reused, failed });
}

async function assembleSnapshot(
  deps: LibraryDeps,
  b: { inputs: string; takesPerCue: number; progress: (p: LibraryProgress) => void; now: () => number },
  t: { prompts: z.infer<typeof PromptsSchema>; modelJson: string; model: SfxClient["model"]; takesDir: string; generated: number; reused: number; failed: LibraryReport["takes"]["failed"] },
): Promise<PreparedLibrary> {
  b.progress({ state: "running", message: "choosing and assembling takes" });
  const snapshots = join(deps.root, "snapshots");
  const staging = join(snapshots, `.staging-${randomBytes(6).toString("hex")}`);
  const candidates = join(staging, ".candidates");
  await mkdir(candidates, { recursive: true });
  try {
    // The committed library (its music and any curated sounds) is the starting point; each file is checked.
    const base = SfxCatalogueSchema.parse(JSON.parse(await readFile(join(deps.sourceDir, "index.json"), "utf8")));
    for (const e of base.entries) {
      const bytes = await readFile(join(deps.sourceDir, e.path));
      if (sha256(bytes) !== e.sha256) throw new LibraryError(`assets/sfx/${e.path} does not match its hash in index.json; restore it from git`);
      await writeAtomic(join(staging, e.path), bytes);
    }
    await copyFile(join(deps.sourceDir, "index.json"), join(staging, "index.json"));
    await copyFile(join(deps.sourceDir, "prompts.json"), join(staging, "prompts.json"));
    if (existsSync(join(deps.sourceDir, "music-sources.json"))) await copyFile(join(deps.sourceDir, "music-sources.json"), join(staging, "music-sources.json"));
    const attribution = join(staging, "ATTRIBUTION.md");
    await writeFile(attribution, "# Sound library attribution\n\n## Sound effects and music\n\n");

    // The takes of this build, laid out as the assembler reads them.
    const takes: Record<string, Record<string, unknown>> = {};
    for (const cue of t.prompts.cues) {
      for (let n = 1; n <= b.takesPerCue; n++) {
        const seed = cue.seed + n - 1;
        const rec = getTake(deps.db, takeKey(t.modelJson, { prompt: cue.prompt, durationSec: cue.durationSec, seed }, n));
        if (rec?.state !== "done" || !rec.file || !rec.sha256) continue;
        await mkdir(join(candidates, cue.id), { recursive: true });
        const to = join(candidates, cue.id, `take-${n}.wav`);
        await link(join(t.takesDir, rec.file), to).catch(() => copyFile(join(t.takesDir, rec.file!), to));
        (takes[cue.id] ??= {})[String(n)] = { prompt: cue.prompt, durationSec: cue.durationSec, seed, file: `take-${n}.wav`, sha256: rec.sha256, at: new Date(rec.updatedAt).toISOString().replace(/\.\d{3}Z$/, "Z") };
      }
    }
    if (Object.keys(takes).length === 0) {
      throw new LibraryError(`no sound effect could be generated${t.failed[0] ? ` (first failure: ${t.failed[0].error})` : ""}; check the sound-effect server and retry the job`);
    }
    await writeFile(join(candidates, "takes.json"), JSON.stringify({ model: JSON.parse(t.modelJson), takes }));
    let foley;
    try {
      foley = await autoAssemble({ sfxDir: staging, candidatesDir: candidates, attribution }, deps.ff);
    } catch (err) {
      if (err instanceof AssembleError) throw new LibraryError(`the sound library could not be assembled: ${err.message}`);
      throw err;
    }
    let catalogue = SfxCatalogueSchema.parse(JSON.parse(await readFile(join(staging, "index.json"), "utf8")));
    if (!catalogue.musicCues.theme) {
      // Music comes only from the committed sources, already downloaded by the operator; nothing is fetched or synthesised.
      try {
        await importMusic({ sfxDir: staging, musicDir: deps.musicDir, attribution }, deps.ff);
      } catch (err) {
        if (err instanceof AssembleError) throw new LibraryError(`the sound library has no theme music: ${err.message}`);
        throw err;
      }
      catalogue = SfxCatalogueSchema.parse(JSON.parse(await readFile(join(staging, "index.json"), "utf8")));
    }
    await rm(candidates, { recursive: true, force: true });

    const report: LibraryReport = {
      version: LIBRARY_BUILD_VERSION,
      inputsSha: b.inputs,
      model: { model: t.model.model, revision: t.model.revision, weightsSha256: t.model.weightsSha256, license: t.model.license },
      takes: { generated: t.generated, reused: t.reused, failed: t.failed },
      foley: { assembled: foley.assembled.assembled.map((a) => a.id), omitted: foley.report.cues.filter((c) => c.picked === null).map((c) => ({ id: c.id, reason: c.reason })) },
      music: Object.fromEntries(Object.entries(catalogue.musicCues).filter((e): e is [string, string] => typeof e[1] === "string")),
    };
    await writeFile(join(staging, "library-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (!(await verifySnapshot(staging, catalogue.id))) throw new LibraryError("the assembled sound library failed its own hash check");

    // Publish: the folder is renamed into place whole, then made current.
    const target = join(snapshots, catalogue.id);
    if (existsSync(target)) {
      if (await verifySnapshot(target, catalogue.id)) await rm(staging, { recursive: true, force: true });
      else {
        const trash = join(snapshots, `.trash-${randomBytes(6).toString("hex")}`);
        await rename(target, trash);
        await rename(staging, target);
        await rm(trash, { recursive: true, force: true });
      }
    } else await rename(staging, target);
    deps.fence?.();
    publishSnapshot(deps.db, { id: catalogue.id, dir: target, promptsSha: b.inputs, modelJson: t.modelJson, report }, b.now());
    deps.fence?.();
    const bound = deps.bind();
    if (bound !== catalogue.id) throw new Error("another sound library was published during this build; retrying");
    for (const o of report.foley.omitted) deps.log(`sound library: ${o.id} left out (${o.reason})`);
    b.progress({ state: "done", message: `sound library ${catalogue.id}: ${report.foley.assembled.length} effect(s) assembled, ${report.foley.omitted.length} left out` });
    return { snapshotId: catalogue.id, dir: target, catalogue, reused: false, outOfDate: false, report };
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

/** Remove snapshots no unfinished job needs, and staging folders left by a crash. Run under the lock. */
export async function collectUnused(db: DatabaseSync, root: string, now = Date.now()): Promise<string[]> {
  const snapshots = join(root, "snapshots");
  const removed: SnapshotRecord[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const keep = snapshotsInUse(db);
    for (const s of listSnapshots(db)) {
      if (keep.has(s.id) || s.isCurrent) continue;
      deleteSnapshotRecord(db, s.id);
      removed.push(s);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  for (const s of removed) if (inside(snapshots, s.dir)) await rm(s.dir, { recursive: true, force: true });
  const known = new Set(listSnapshots(db).map((s) => resolve(s.dir)));
  for (const name of existsSync(snapshots) ? await readdir(snapshots) : []) {
    const path = join(snapshots, name);
    if (known.has(resolve(path))) continue;
    const old = now - (await stat(path)).mtimeMs > 60 * 60_000;
    if (name.startsWith(".staging-") || name.startsWith(".trash-") ? old : true) await rm(path, { recursive: true, force: true });
  }
  return removed.map((s) => s.id);
}
