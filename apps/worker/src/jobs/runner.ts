import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { JobCancelledError, LeaseLostError, OverBudgetError, PermanentJobError } from "./errors.js";
import type { Job, JobQueue, Lease } from "./queue.js";

export interface JobContext {
  job: Job;
  lease: Lease;
  /** Aborted when the lease is lost or the worker is shutting down. Pass it to long calls. */
  signal: AbortSignal;
  /** Fenced DB write; throws LeaseLostError if this worker no longer owns the job. */
  publish<T>(fn: (db: DatabaseSync) => T): T;
  /** Throws LeaseLostError unless this worker still owns the job. Pass as the BudgetLedger `fence`. */
  assertLease(): void;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface RunnerOptions {
  queue: JobQueue;
  handlers: Record<string, JobHandler>;
  /** Defaults to a third of the lease. */
  heartbeatMs?: number;
  pollMs?: number;
  /** Abort to stop claiming; the current job is released for another worker. */
  signal?: AbortSignal;
  /**
   * Reports handler failures (with their job) and infrastructure errors such as a locked database
   * during claim or heartbeat (job may be undefined). Must not throw.
   */
  onError?: (err: unknown, job?: Job) => void;
}

/** Claim and run one job. Returns false when nothing was claimed. */
export async function runOnce(opts: RunnerOptions): Promise<boolean> {
  const { queue, handlers } = opts;
  if (opts.signal?.aborted) return false; // A listener added to an aborted signal never fires.
  const claimed = queue.claim(Object.keys(handlers));
  if (!claimed) return false;
  const { job, lease } = claimed;
  const handler = handlers[job.kind]!;

  const ctrl = new AbortController();
  const onShutdown = () => ctrl.abort(new Error("worker shutting down"));
  opts.signal?.addEventListener("abort", onShutdown, { once: true });
  const beat = setInterval(() => {
    // An exception thrown from a timer callback would crash the process. A transient failure
    // (e.g. "database is locked") is reported and retried on the next tick; if it persists, the
    // lease expires, the next successful heartbeat returns false and the job is aborted.
    try {
      if (!queue.heartbeat(lease)) ctrl.abort(new LeaseLostError(job.id));
      else if (queue.cancellationRequested(job.id)) ctrl.abort(new JobCancelledError(job.id));
    } catch (err) {
      report(opts, err, job);
    }
  }, opts.heartbeatMs ?? Math.max(1, Math.floor(queue.leaseMs / 3)));

  try {
    await handler({
      job,
      lease,
      signal: ctrl.signal,
      publish: (fn) => queue.publish(lease, fn),
      assertLease: () => {
        if (!queue.holds(lease)) throw new LeaseLostError(job.id);
      },
    });
    queue.complete(lease); // Fenced: throws LeaseLostError if ownership was lost meanwhile.
  } catch (err) {
    settleFailure(opts, lease, job, ctrl.signal.reason instanceof JobCancelledError ? ctrl.signal.reason : err);
  } finally {
    clearInterval(beat);
    opts.signal?.removeEventListener("abort", onShutdown);
  }
  return true;
}

function settleFailure(opts: RunnerOptions, lease: Lease, job: Job, err: unknown): void {
  const { queue } = opts;
  try {
    if (err instanceof LeaseLostError || !queue.holds(lease)) return; // Another worker owns it now.
    if (err instanceof JobCancelledError) return queue.cancel(lease);
    if (opts.signal?.aborted) return queue.release(lease);
    report(opts, err, job);
    if (err instanceof OverBudgetError) return queue.pauseOverBudget(lease, err.message);
    queue.fail(lease, err, { retry: !(err instanceof PermanentJobError) });
  } catch (e) {
    // Could not record the outcome (lease lapsed, or the DB is busy). The lease will expire and the
    // job will be reclaimed, so report and carry on rather than stopping the worker.
    if (!(e instanceof LeaseLostError)) report(opts, e, job);
  }
}

/**
 * Poll for work until `signal` aborts. Recovers jobs left `running` by a crashed worker once their
 * lease expires. Errors never stop the loop: they are reported and followed by a back-off.
 */
export async function runWorker(opts: RunnerOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  let failures = 0;
  while (!opts.signal?.aborted) {
    let worked = false;
    try {
      worked = await runOnce(opts);
      failures = 0;
    } catch (err) {
      failures++;
      report(opts, err);
    }
    if (!worked) {
      const wait = failures > 0 ? Math.min(pollMs * 2 ** (failures - 1), 30_000) : pollMs;
      await sleep(wait, undefined, { signal: opts.signal }).catch(() => undefined);
    }
  }
}

function report(opts: RunnerOptions, err: unknown, job?: Job): void {
  try {
    opts.onError?.(err, job);
  } catch {
    // A broken reporter must not take the worker down.
  }
}
