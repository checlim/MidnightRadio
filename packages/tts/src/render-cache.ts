import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { renderCacheKey } from "./cache-key.js";
import { rejected, SynthesisRequestSchema, TtsError, type SynthesisRequest, type TtsProvider } from "./provider.js";
import { aborted, Semaphore } from "./semaphore.js";
import { validateWav, WavError, type WavInfo } from "./wav.js";

/**
 * Content-addressed cache of rendered speech (Req 5.2). One file per exact request:
 * `<key>.wav`, where the key is `renderCacheKey`. Rules:
 *
 * - Only complete, validated WAVs are ever visible under a final name. Audio is written to a
 *   unique same-directory temp file, validated, flushed to disk, then atomically renamed.
 * - A hit is re-validated on every read; a damaged file is discarded and re-rendered.
 * - Identical requests in flight share one render; distinct renders are limited (default 2).
 * - Temp files, however they were left behind, are never hits.
 *
 * The database is updated by the caller after `render` returns (inside a fenced `publish`), so a
 * crash between the rename and that commit leaves a valid orphan that the next run reuses.
 */

export interface RenderResult {
  key: string;
  /** Absolute path of the published `<key>.wav`. */
  path: string;
  info: WavInfo;
  /** True if the audio was already in the cache (or another caller rendered it first). */
  cached: boolean;
}

export interface RenderInfo {
  chars: number;
  voiceId: string;
}

export interface RenderCacheOptions {
  dir: string;
  provider: TtsProvider;
  /** Most distinct renders running at once. Default 2. */
  concurrency?: number;
  /**
   * Wraps each real render (never a hit or a coalesced wait). The worker passes the budget ledger
   * here, so every render is reserved before the model runs. Throwing refuses the render.
   */
  around?: <T>(info: RenderInfo, call: () => Promise<T>) => Promise<T>;
  /** Test seams: run at the two points that matter for crash recovery. */
  hooks?: { afterTempWritten?: () => void | Promise<void>; afterRename?: () => void | Promise<void> };
}

export interface RenderOptions {
  /** Job that owns this render; part of the temp file name, so a sweep can tell who is writing. */
  jobId?: string;
  signal?: AbortSignal;
}

export interface CacheStats {
  /** Renders served from an existing valid file. */
  hits: number;
  /** Renders that ran the provider and published a file. */
  renders: number;
  /** Damaged cache files discarded. */
  repaired: number;
}

interface Shared {
  promise: Promise<RenderResult>;
  controller: AbortController;
  waiters: number;
}

const TEMP_NAME = /^([0-9a-f]{64})\.([\w-]{1,64})\.([0-9a-f]{12})\.wav\.tmp$/;
const DEFAULT_ABANDONED_MS = 10 * 60_000;

const isNotFound = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

export class RenderCache {
  readonly stats: CacheStats = { hits: 0, renders: 0, repaired: 0 };
  readonly provider: TtsProvider;
  private readonly dir: string;
  private readonly around: RenderCacheOptions["around"];
  private readonly hooks: NonNullable<RenderCacheOptions["hooks"]>;
  private readonly slots: Semaphore;
  private readonly inflight = new Map<string, Shared>();
  private readonly activeTemps = new Set<string>();
  private ready: Promise<unknown> | undefined;

  constructor(opts: RenderCacheOptions) {
    this.provider = opts.provider;
    this.dir = opts.dir;
    this.around = opts.around;
    this.hooks = opts.hooks ?? {};
    this.slots = new Semaphore(opts.concurrency ?? 2);
  }

  pathFor(key: string): string {
    return join(this.dir, `${key}.wav`);
  }

  /** The cache key for a request. Throws "rejected" for an invalid request or unknown voice. */
  keyOf(request: SynthesisRequest): string {
    return this.keyFor(request).key;
  }

  /** Whether a file is published under this key. Cheaper than `lookup` (no validation), for estimates. */
  async isPublished(key: string): Promise<boolean> {
    return stat(this.pathFor(key)).then((s) => s.isFile(), () => false);
  }

  /** The cached audio for this request, if a valid file exists. Never renders. */
  async lookup(request: SynthesisRequest): Promise<RenderResult | undefined> {
    const { key } = this.keyFor(request);
    const hit = await this.readValid(key);
    return hit && { ...hit, cached: true };
  }

  /** Cached audio if present, otherwise one render shared by every identical concurrent caller. */
  async render(request: SynthesisRequest, opts: RenderOptions = {}): Promise<RenderResult> {
    if (opts.signal?.aborted) throw aborted();
    const { key, req } = this.keyFor(request);
    const hit = await this.readValid(key);
    if (hit) {
      this.stats.hits++;
      return { ...hit, cached: true };
    }
    const shared = this.inflight.get(key) ?? this.start(key, req, opts.jobId);
    return this.wait(shared, opts.signal);
  }

  /**
   * Remove temp files left by writers that died. A file is removed only if this process is not
   * writing it, its job is not reported active, and it is older than `olderThanMs`. Only files
   * named like our temp files are ever touched. Returns the removed names.
   */
  async sweepAbandoned(opts: { olderThanMs?: number; isJobActive?: (jobId: string) => boolean; now?: number } = {}): Promise<string[]> {
    const olderThan = opts.olderThanMs ?? DEFAULT_ABANDONED_MS;
    const now = opts.now ?? Date.now();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const removed: string[] = [];
    for (const name of names) {
      const m = TEMP_NAME.exec(name);
      if (!m) continue;
      const path = join(this.dir, name);
      if (this.activeTemps.has(path) || opts.isJobActive?.(m[2]!)) continue;
      let info;
      try {
        info = await stat(path);
      } catch {
        continue; // already gone
      }
      if (now - info.mtimeMs < olderThan) continue;
      await rm(path, { force: true });
      removed.push(name);
    }
    return removed;
  }

  private keyFor(request: SynthesisRequest): { key: string; req: SynthesisRequest } {
    const parsed = SynthesisRequestSchema.safeParse(request);
    if (!parsed.success) throw rejected(`invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "request"} ${i.message}`).join("; ")}`);
    return { key: renderCacheKey(this.provider, parsed.data), req: parsed.data }; // throws "rejected" for an unknown voice
  }

  private start(key: string, req: SynthesisRequest, jobId: string | undefined): Shared {
    const controller = new AbortController();
    const shared: Shared = { controller, waiters: 0, promise: undefined as never };
    shared.promise = this.produce(key, req, jobId, controller.signal).finally(() => {
      if (this.inflight.get(key) === shared) this.inflight.delete(key);
    });
    this.inflight.set(key, shared);
    return shared;
  }

  /** Wait for a shared render. Aborting leaves only this caller; the render stops when nobody is left waiting. */
  private wait(shared: Shared, signal?: AbortSignal): Promise<RenderResult> {
    shared.waiters++;
    return new Promise<RenderResult>((resolve, reject) => {
      let settled = false;
      const done = () => {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        done();
        if (--shared.waiters === 0) shared.controller.abort();
        reject(aborted());
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (r) => {
          if (settled) return;
          done();
          resolve(r);
        },
        (e) => {
          if (settled) return;
          done();
          reject(e);
        },
      );
    });
  }

  private async produce(key: string, req: SynthesisRequest, jobId: string | undefined, signal: AbortSignal): Promise<RenderResult> {
    await this.slots.acquire(signal);
    try {
      if (signal.aborted) throw aborted();
      // Someone (another process, or a caller that just finished) may have published it while we queued.
      const existing = await this.readValid(key);
      if (existing) {
        this.stats.hits++;
        return { ...existing, cached: true };
      }
      const run = () => this.synthesizeAndPublish(key, req, jobId, signal);
      return this.around ? await this.around({ chars: req.text.length, voiceId: req.voiceId }, run) : await run();
    } finally {
      this.slots.release();
    }
  }

  private async synthesizeAndPublish(key: string, req: SynthesisRequest, jobId: string | undefined, signal: AbortSignal): Promise<RenderResult> {
    if (signal.aborted) throw aborted();
    const wav = await this.provider.synthesize(req, { signal });
    try {
      validateWav(wav);
    } catch (err) {
      if (err instanceof WavError) throw invalidOutput(`the voice model produced unusable audio (${err.code}: ${err.message})`);
      throw err;
    }

    await (this.ready ??= mkdir(this.dir, { recursive: true }));
    const finalPath = this.pathFor(key);
    const tempPath = join(this.dir, `${key}.${safeJobId(jobId)}.${randomBytes(6).toString("hex")}.wav.tmp`);
    this.activeTemps.add(tempPath);
    let renamed = false;
    try {
      const file = await open(tempPath, "wx", 0o644); // exclusive: never reuse another writer's file
      try {
        await file.writeFile(wav);
        await file.sync(); // flush to disk before the rename can make it visible
      } finally {
        await file.close();
      }
      // Check what actually reached the disk, not just what we meant to write.
      let info: WavInfo;
      try {
        info = validateWav(await readFile(tempPath));
      } catch (err) {
        if (err instanceof WavError) throw invalidOutput(`the written file failed validation (${err.code}: ${err.message})`);
        throw err;
      }
      await this.hooks.afterTempWritten?.();
      await rename(tempPath, finalPath); // atomic within one directory
      renamed = true;
      await this.syncDirectory();
      await this.hooks.afterRename?.();
      this.stats.renders++;
      return { key, path: finalPath, info, cached: false };
    } finally {
      this.activeTemps.delete(tempPath);
      if (!renamed) await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  /** The file for `key` if it exists and validates. A damaged file is discarded (unless it changed meanwhile). */
  private async readValid(key: string): Promise<Omit<RenderResult, "cached"> | undefined> {
    const path = this.pathFor(key);
    let before;
    try {
      before = await stat(path);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    if (!before.isFile()) return undefined;
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    try {
      return { key, path, info: validateWav(bytes) };
    } catch (err) {
      if (!(err instanceof WavError)) throw err;
    }
    // Damaged. Another process may have just replaced it with a good file, so only remove what we read.
    const now = await stat(path).catch(() => undefined);
    if (now && now.ino === before.ino && now.size === before.size && now.mtimeMs === before.mtimeMs) {
      await rm(path, { force: true });
      this.stats.repaired++;
    }
    return undefined;
  }

  private async syncDirectory(): Promise<void> {
    try {
      const dir = await open(this.dir, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Some platforms cannot fsync a directory. The rename is still atomic.
    }
  }
}

const invalidOutput = (message: string) => new TtsError("invalid_output", message, true, true);

/** Job ids go into file names: keep letters, digits, underscore and dash. */
const safeJobId = (jobId: string | undefined) => (jobId ?? "nojob").replace(/[^\w-]/g, "_").slice(0, 64) || "nojob";
