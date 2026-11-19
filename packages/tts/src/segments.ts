import type { Delivery } from "@midnight-radio/core";
import { OverBudgetError } from "@midnight-radio/db";
import { describeError, type ErrorSummary } from "./redact.js";
import { TtsError, type SynthesisRequest } from "./provider.js";
import type { RenderCache, RenderResult } from "./render-cache.js";
import { aborted } from "./semaphore.js";

/**
 * Rendering a chapter's speech lines (Req 5.3, 5.6).
 *
 * - A failing line is retried with exponential backoff, then recorded as failed on its own; every
 *   other line still renders and nothing already rendered is thrown away.
 * - Failures that concern the whole job (budget exhausted, job lease lost, shutdown) stop the run
 *   instead of being recorded against a line. Lines finished before that were already reported.
 * - Error text reaching callbacks and results is redacted and short.
 */

export interface RenderSegment {
  /** Caller's identifier for the line (e.g. the segment row id). Unique within a run. */
  id: string;
  voiceId: string;
  text: string;
  delivery?: Delivery;
}

export type SegmentOutcome =
  | { id: string; status: "rendered" | "cached"; result: RenderResult; attempts: number }
  | { id: string; status: "failed"; error: ErrorSummary; attempts: number };

export interface RetryInfo {
  id: string;
  /** The attempt that just failed (1 = the first try). */
  attempt: number;
  /** Time before the next attempt. */
  waitMs: number;
  error: ErrorSummary;
}

export interface RenderSegmentsOptions {
  cache: RenderCache;
  jobId?: string;
  signal?: AbortSignal;
  /** Retries after the first attempt (Req 5.3: 3). Default 3, so at most 4 attempts. */
  maxRetries?: number;
  /** Wait before the first retry; doubles each time. Default 1000 ms. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Lines rendered at once. The cache still limits distinct model calls. Default 4. */
  parallelism?: number;
  /** Treat an error as concerning the whole job (e.g. the worker's lease-lost error). */
  isFatal?: (err: unknown) => boolean;
  /** Called as each line finishes, so completed work can be recorded at once. If it throws, the run stops with that error. */
  onSegment?: (outcome: SegmentOutcome) => void | Promise<void>;
  onRetry?: (info: RetryInfo) => void;
  /** Exact secret values to mask in error text, in addition to credential-looking text. */
  secrets?: readonly string[];
  /** Replaceable for tests. Must reject with an aborted TtsError if the signal fires. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_PARALLELISM = 4;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Backoff before retry number `retry` (1-based): base, 2×base, 4×base… up to the cap. */
export const backoffMs = (retry: number, baseMs = DEFAULT_BASE_DELAY_MS, maxMs = DEFAULT_MAX_DELAY_MS): number => Math.min(maxMs, baseMs * 2 ** (retry - 1));

/**
 * Render every line, returning one outcome per line in input order. Rejects, after reporting the
 * lines that did finish, only for job-level failures: budget (`OverBudgetError`), abort, `isFatal`
 * errors, or an `onSegment` callback that throws.
 */
export async function renderSegments(segments: readonly RenderSegment[], opts: RenderSegmentsOptions): Promise<SegmentOutcome[]> {
  const ids = new Set<string>();
  for (const s of segments) {
    if (ids.has(s.id)) throw new Error(`duplicate segment id "${s.id}"`);
    ids.add(s.id);
  }
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const delay = opts.delay ?? sleep;
  const describe = (err: unknown) => describeError(err, opts.secrets);
  const stopsJob = (err: unknown) =>
    err instanceof OverBudgetError || (err instanceof TtsError && err.kind === "aborted") || opts.signal?.aborted === true || (opts.isFatal?.(err) ?? false);

  const outcomes: SegmentOutcome[] = new Array(segments.length);
  let next = 0;
  let fatal: { error: unknown } | undefined;

  const renderOne = async (segment: RenderSegment): Promise<SegmentOutcome> => {
    const request: SynthesisRequest = { voiceId: segment.voiceId, text: segment.text, ...(segment.delivery ? { delivery: segment.delivery } : {}) };
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await opts.cache.render(request, { ...(opts.jobId ? { jobId: opts.jobId } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
        return { id: segment.id, status: result.cached ? "cached" : "rendered", result, attempts: attempt };
      } catch (err) {
        if (stopsJob(err)) throw err;
        const error = describe(err);
        if (!error.retryable || attempt > maxRetries) return { id: segment.id, status: "failed", error, attempts: attempt };
        const waitMs = backoffMs(attempt, baseDelay, maxDelay);
        opts.onRetry?.({ id: segment.id, attempt, waitMs, error });
        await delay(waitMs, opts.signal);
      }
    }
  };

  const worker = async () => {
    while (!fatal && !opts.signal?.aborted) {
      const i = next++;
      if (i >= segments.length) return;
      try {
        const outcome = await renderOne(segments[i]!);
        outcomes[i] = outcome;
        await opts.onSegment?.(outcome);
      } catch (err) {
        fatal ??= { error: err };
        return;
      }
    }
  };

  const pool = Math.max(1, Math.min(opts.parallelism ?? DEFAULT_PARALLELISM, segments.length));
  await Promise.all(Array.from({ length: pool }, worker));
  if (fatal) throw fatal.error;
  if (opts.signal?.aborted) throw aborted();
  return outcomes;
}

export interface RenderPlan {
  /** Lines in the chapter, and all their characters. */
  segments: number;
  totalChars: number;
  /** Distinct renders needed (identical lines render once), split by whether the audio is already published. */
  uniqueRenders: number;
  cachedRenders: number;
  toRender: number;
  cachedChars: number;
  toRenderChars: number;
  /**
   * Estimated time to render what is not cached. Assumes the renders run one after another, which
   * is the safe assumption on a single local model, and ignores retries.
   */
  estimatedRenderMs: number;
  /** Lines that cannot be rendered at all (unknown voice, blank text…). */
  problems: { id: string; message: string }[];
}

/**
 * What rendering this chapter would involve, computed before anything is rendered (Req 5.6).
 * "Cached" means a file is published under the key; it is validated when actually used.
 */
export async function planRender(cache: RenderCache, segments: readonly RenderSegment[]): Promise<RenderPlan> {
  const plan: RenderPlan = {
    segments: segments.length,
    totalChars: 0,
    uniqueRenders: 0,
    cachedRenders: 0,
    toRender: 0,
    cachedChars: 0,
    toRenderChars: 0,
    estimatedRenderMs: 0,
    problems: [],
  };
  const seen = new Set<string>();
  for (const s of segments) {
    plan.totalChars += s.text.length;
    let key: string;
    try {
      key = cache.keyOf({ voiceId: s.voiceId, text: s.text, ...(s.delivery ? { delivery: s.delivery } : {}) });
    } catch (err) {
      plan.problems.push({ id: s.id, message: describeError(err).message });
      continue;
    }
    if (seen.has(key)) continue; // an identical line renders once
    seen.add(key);
    plan.uniqueRenders++;
    if (await cache.isPublished(key)) {
      plan.cachedRenders++;
      plan.cachedChars += s.text.length;
    } else {
      plan.toRender++;
      plan.toRenderChars += s.text.length;
      plan.estimatedRenderMs += cache.provider.estimateRenderMs(s.text.length);
    }
  }
  return plan;
}
