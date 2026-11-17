import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LeaseLostError } from "./errors.js";

export type JobState = "queued" | "running" | "done" | "failed" | "over_budget";

export interface Job {
  id: string;
  kind: string;
  refId: string;
  state: JobState;
  attempts: number;
  leaseUntil: number | null;
  leaseToken: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Proof of ownership for a claimed job. Every write on the job's behalf must present it. */
export interface Lease {
  jobId: string;
  token: string;
}

export interface JobQueueOptions {
  /** Lease duration; renewed by heartbeats. */
  leaseMs?: number;
  /** Total claims allowed (initial run + retries, including crash reclaims) before a job fails. */
  maxAttempts?: number;
  now?: () => number;
  newId?: () => string;
}

const MAX_ERROR_CHARS = 2000;

interface JobRow {
  id: string;
  kind: string;
  ref_id: string;
  state: JobState;
  attempts: number;
  lease_until: number | null;
  lease_token: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  kind: r.kind,
  refId: r.ref_id,
  state: r.state,
  attempts: Number(r.attempts),
  leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
  leaseToken: r.lease_token,
  error: r.error,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/**
 * SQLite-backed job queue with leases.
 *
 * - `claim` is a single atomic UPDATE...RETURNING, safe across processes sharing the DB file.
 * - Expired `running` leases are reclaimable, which is how work resumes after a crash or restart.
 * - Each claim issues a fresh lease token; `publish`/`complete`/`fail` verify it inside a write
 *   transaction, so a stale worker cannot publish after its job was reclaimed.
 */
export class JobQueue {
  readonly leaseMs: number;
  readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly db: DatabaseSync,
    opts: JobQueueOptions = {},
  ) {
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
    if (this.leaseMs <= 0 || this.maxAttempts < 1) throw new Error("invalid JobQueue options");
  }

  /** Enqueue a job, or return the existing queued/running job for the same (kind, refId). */
  enqueue(kind: string, refId: string): Job {
    return this.tx(() => {
      const existing = this.db
        .prepare("SELECT * FROM jobs WHERE kind = ? AND ref_id = ? AND state IN ('queued', 'running')")
        .get(kind, refId) as JobRow | undefined;
      if (existing) return toJob(existing);
      const t = this.now();
      const row = this.db
        .prepare(
          "INSERT INTO jobs (id, kind, ref_id, state, attempts, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?) RETURNING *",
        )
        .get(this.newId(), kind, refId, t, t) as unknown as JobRow;
      return toJob(row);
    });
  }

  /**
   * Atomically claim the oldest queued job, or a running job whose lease has expired.
   * Expired jobs that have used up their attempts are marked failed instead.
   */
  claim(kinds?: readonly string[]): { job: Job; lease: Lease } | null {
    return this.tx(() => {
      const t = this.now();
      const kindsJson = kinds ? JSON.stringify(kinds) : null;
      this.db
        .prepare(
          `UPDATE jobs SET state = 'failed', lease_token = NULL, lease_until = NULL, updated_at = ?,
             error = 'lease expired after ' || attempts || ' attempt(s); worker presumed crashed'
           WHERE state = 'running' AND lease_until < ? AND attempts >= ?`,
        )
        .run(t, t, this.maxAttempts);
      const token = this.newId();
      const row = this.db
        .prepare(
          `UPDATE jobs SET state = 'running', lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = (
             SELECT id FROM jobs
             WHERE (state = 'queued' OR (state = 'running' AND lease_until < ?))
               AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
             ORDER BY created_at, rowid
             LIMIT 1
           )
           RETURNING *`,
        )
        .get(token, t + this.leaseMs, t, t, kindsJson, kindsJson) as JobRow | undefined;
      return row ? { job: toJob(row), lease: { jobId: row.id, token } } : null;
    });
  }

  /** Extend the lease. Returns false if ownership was lost; the caller must stop work. */
  heartbeat(lease: Lease): boolean {
    const t = this.now();
    const res = this.db
      .prepare(
        "UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND state = 'running' AND lease_until >= ?",
      )
      .run(t + this.leaseMs, t, lease.jobId, lease.token, t);
    return Number(res.changes) === 1;
  }

  /** True if `lease` is still the current, unexpired owner. */
  holds(lease: Lease): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM jobs WHERE id = ? AND lease_token = ? AND state = 'running' AND lease_until >= ?")
        .get(lease.jobId, lease.token, this.now()) !== undefined
    );
  }

  /**
   * Fenced publication: run `fn` in a write transaction only if `lease` is still current.
   * `fn` must be synchronous and must not open its own transaction. An atomic file rename may be
   * done inside `fn`; if the transaction then fails, the renamed file is an orphan the next
   * owner can validate and reuse.
   */
  publish<T>(lease: Lease, fn: (db: DatabaseSync) => T): T {
    return this.tx(() => {
      this.assertHolds(lease);
      return fn(this.db);
    });
  }

  /** Mark the job done, optionally publishing final results in the same fenced transaction. */
  complete(lease: Lease, fn?: (db: DatabaseSync) => void): void {
    this.finish(lease, "done", null, fn);
  }

  /** Requeue for another attempt, or fail permanently once attempts are exhausted. */
  fail(lease: Lease, error: unknown, opts: { retry: boolean }): JobState {
    return this.tx(() => {
      const job = this.assertHolds(lease);
      const state: JobState = opts.retry && job.attempts < this.maxAttempts ? "queued" : "failed";
      this.setTerminal(lease, state, errorMessage(error));
      return state;
    });
  }

  /** Park the job until budget is available again; it is not retried automatically. */
  pauseOverBudget(lease: Lease, reason: string): void {
    this.finish(lease, "over_budget", reason);
  }

  /** Give the job back without counting the attempt (graceful shutdown). */
  release(lease: Lease): void {
    this.tx(() => {
      this.assertHolds(lease);
      this.db
        .prepare(
          "UPDATE jobs SET state = 'queued', attempts = MAX(attempts - 1, 0), lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?",
        )
        .run(this.now(), lease.jobId);
    });
  }

  /** Requeue a parked (`over_budget` or `failed`) job, resetting attempts. */
  resume(jobId: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE jobs SET state = 'queued', attempts = 0, error = NULL, updated_at = ? WHERE id = ? AND state IN ('over_budget', 'failed')",
      )
      .run(this.now(), jobId);
    return Number(res.changes) === 1;
  }

  get(jobId: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    return row && toJob(row);
  }

  private finish(lease: Lease, state: JobState, error: string | null, fn?: (db: DatabaseSync) => void): void {
    this.tx(() => {
      this.assertHolds(lease);
      fn?.(this.db);
      this.setTerminal(lease, state, error);
    });
  }

  private setTerminal(lease: Lease, state: JobState, error: string | null): void {
    this.db
      .prepare("UPDATE jobs SET state = ?, error = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?")
      .run(state, error, this.now(), lease.jobId);
  }

  private assertHolds(lease: Lease): Job {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id = ? AND lease_token = ? AND state = 'running' AND lease_until >= ?")
      .get(lease.jobId, lease.token, this.now()) as JobRow | undefined;
    if (!row) throw new LeaseLostError(lease.jobId);
    return toJob(row);
  }

  /** BEGIN IMMEDIATE takes the write lock up front, so check-then-write is atomic across processes. */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Store only the message, never stacks or request details that might contain secrets. */
function errorMessage(error: unknown): string {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return msg.length > MAX_ERROR_CHARS ? `${msg.slice(0, MAX_ERROR_CHARS)}…` : msg;
}
