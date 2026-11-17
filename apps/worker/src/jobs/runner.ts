import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { LeaseLostError, OverBudgetError, PermanentJobError } from "./errors.js";
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
  onError?: (err: unknown, job: Job) => void;
}

/** Claim and run one job. Returns false when nothing was claimable. */
export async function runOnce(opts: RunnerOptions): Promise<boolean> {
  const { queue, handlers } = opts;
  const claimed = queue.claim(Object.keys(handlers));
  if (!claimed) return false;
  const { job, lease } = claimed;
  const handler = handlers[job.kind]!;

  const ctrl = new AbortController();
  const onShutdown = () => ctrl.abort(new Error("worker shutting down"));
  opts.signal?.addEventListener("abort", onShutdown, { once: true });
  const beat = setInterval(() => {
    if (!queue.heartbeat(lease)) ctrl.abort(new LeaseLostError(job.id));
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
    settleFailure(queue, lease, job, err, opts.signal?.aborted ?? false, opts.onError);
  } finally {
    clearInterval(beat);
    opts.signal?.removeEventListener("abort", onShutdown);
  }
  return true;
}

function settleFailure(
  queue: JobQueue,
  lease: Lease,
  job: Job,
  err: unknown,
  shuttingDown: boolean,
  onError?: (err: unknown, job: Job) => void,
): void {
  try {
    if (err instanceof LeaseLostError || !queue.holds(lease)) return; // Another worker owns it now.
    if (shuttingDown) return queue.release(lease);
    onError?.(err, job);
    if (err instanceof OverBudgetError) return queue.pauseOverBudget(lease, err.message);
    queue.fail(lease, err, { retry: !(err instanceof PermanentJobError) });
  } catch (e) {
    if (!(e instanceof LeaseLostError)) throw e; // Lease lapsed while settling: leave it to reclaim.
  }
}

/** Poll for work until `signal` aborts. Recovers jobs left `running` by a crashed worker once their lease expires. */
export async function runWorker(opts: RunnerOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  while (!opts.signal?.aborted) {
    const worked = await runOnce(opts);
    if (!worked) await sleep(pollMs, undefined, { signal: opts.signal }).catch(() => undefined);
  }
}
