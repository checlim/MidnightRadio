import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "@midnight-radio/db";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeaseLostError } from "./errors.js";
import { JobQueue, type Lease } from "./queue.js";

const LEASE = 1_000;
let db: DatabaseSync;
let clock: number;
let ids: number;
const queue = (database = db) =>
  new JobQueue(database, { leaseMs: LEASE, maxAttempts: 3, now: () => clock, newId: () => `id-${++ids}` });

const withOutputs = (d: DatabaseSync) => {
  d.exec("CREATE TABLE test_outputs (job_id TEXT NOT NULL, token TEXT NOT NULL)");
  return d;
};

beforeEach(() => {
  db = withOutputs(openDb(":memory:"));
  clock = 1_000_000;
  ids = 0;
});
afterEach(() => db.close());

const markPublished = (q: JobQueue, lease: Lease) =>
  q.publish(lease, (d) => d.prepare("INSERT INTO test_outputs (job_id, token) VALUES (?, ?)").run(lease.jobId, lease.token));
const outputs = (d = db) => d.prepare("SELECT job_id, token FROM test_outputs").all();

describe("enqueue", () => {
  it("coalesces identical active jobs and allows a new one after completion", () => {
    const q = queue();
    const a = q.enqueue("render", "c1");
    expect(q.enqueue("render", "c1").id).toBe(a.id);
    expect(q.enqueue("adapt", "c1").id).not.toBe(a.id);
    const { lease } = q.claim(["render"])!;
    expect(q.enqueue("render", "c1").id).toBe(a.id); // still running
    q.complete(lease);
    expect(q.enqueue("render", "c1").id).not.toBe(a.id);
  });
});

describe("claim", () => {
  it("claims oldest first, filters by kind, and never hands one job to two workers", () => {
    const q = queue();
    q.enqueue("adapt", "c1");
    clock += 1;
    q.enqueue("render", "c2");
    expect(q.claim(["render"])!.job.refId).toBe("c2");
    expect(q.claim(["render"])).toBeNull();
    const first = q.claim()!;
    expect(first.job.kind).toBe("adapt");
    expect(first.job.attempts).toBe(1);
    expect(first.job.leaseUntil).toBe(clock + LEASE);
    expect(q.claim()).toBeNull();
  });

  it("is atomic across two connections to the same database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-q-"));
    try {
      const path = join(dir, "q.db");
      const a = openDb(path);
      const b = openDb(path);
      const qa = queue(a);
      const qb = queue(b);
      qa.enqueue("render", "c1");
      const claims = [qa.claim(), qb.claim(), qa.claim(), qb.claim()].filter(Boolean);
      expect(claims).toHaveLength(1);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("leases and fencing", () => {
  it("heartbeat extends the lease while owned", () => {
    const q = queue();
    q.enqueue("render", "c1");
    const { lease } = q.claim()!;
    clock += LEASE - 1;
    expect(q.heartbeat(lease)).toBe(true);
    clock += LEASE - 1;
    expect(q.claim()).toBeNull(); // still leased thanks to heartbeat
    expect(q.holds(lease)).toBe(true);
  });

  it("recovers a crashed worker's job after lease expiry and fences the stale worker", () => {
    const q = queue();
    q.enqueue("render", "c1");
    const stale = q.claim()!.lease;
    clock += LEASE + 1; // worker crashed: no heartbeat
    expect(q.heartbeat(stale)).toBe(false);
    const fresh = q.claim()!;
    expect(fresh.job.attempts).toBe(2);
    expect(fresh.lease.token).not.toBe(stale.token);
    expect(() => markPublished(q, stale)).toThrow(LeaseLostError);
    expect(() => q.complete(stale)).toThrow(LeaseLostError);
    expect(() => q.fail(stale, new Error("x"), { retry: true })).toThrow(LeaseLostError);
    markPublished(q, fresh.lease);
    q.complete(fresh.lease);
    expect(q.get(fresh.job.id)).toMatchObject({ state: "done", leaseToken: null });
    expect(outputs()).toEqual([{ job_id: fresh.job.id, token: fresh.lease.token }]);
  });

  it("refuses publication once the lease has lapsed, even before anyone reclaims it", () => {
    const q = queue();
    q.enqueue("render", "c1");
    const { lease } = q.claim()!;
    clock += LEASE + 1;
    expect(() => markPublished(q, lease)).toThrow(LeaseLostError);
  });

  it("rolls back fenced writes when the publish callback throws", () => {
    const q = queue();
    q.enqueue("render", "c1");
    const { lease, job } = q.claim()!;
    expect(() =>
      q.publish(lease, (d) => {
        d.prepare("INSERT INTO test_outputs (job_id, token) VALUES (?, 'partial')").run(job.id);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(outputs()).toEqual([]);
    expect(q.holds(lease)).toBe(true);
  });

  it("fails a job whose worker keeps crashing once attempts are exhausted", () => {
    const q = queue();
    const { id } = q.enqueue("render", "c1");
    for (let i = 0; i < 3; i++) {
      expect(q.claim()).not.toBeNull();
      clock += LEASE + 1;
    }
    expect(q.claim()).toBeNull();
    expect(q.get(id)).toMatchObject({ state: "failed", attempts: 3, leaseToken: null });
    expect(q.get(id)!.error).toMatch(/lease expired after 3 attempt/);
  });

  it("survives a process restart: a job left running is resumed from the file database", () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-q-"));
    try {
      const path = join(dir, "q.db");
      const before = openDb(path);
      queue(before).enqueue("render", "c1");
      queue(before).claim();
      before.close(); // simulated crash with job mid-flight
      clock += LEASE + 1;
      const after = openDb(path);
      const resumed = queue(after).claim()!;
      expect(resumed.job).toMatchObject({ refId: "c1", attempts: 2, state: "running" });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fail, pause, release, resume", () => {
  it("retries until maxAttempts, then fails; permanent errors fail immediately", () => {
    const q = queue();
    const { id } = q.enqueue("render", "c1");
    expect(q.fail(q.claim()!.lease, new Error("tts 500"), { retry: true })).toBe("queued");
    expect(q.fail(q.claim()!.lease, new Error("tts 500"), { retry: true })).toBe("queued");
    expect(q.fail(q.claim()!.lease, new Error("tts 500"), { retry: true })).toBe("failed");
    expect(q.get(id)).toMatchObject({ state: "failed", attempts: 3, error: "Error: tts 500" });

    const other = q.enqueue("adapt", "c1");
    expect(q.fail(q.claim()!.lease, new Error("bad input"), { retry: false })).toBe("failed");
    expect(q.get(other.id)!.attempts).toBe(1);
  });

  it("truncates stored error messages", () => {
    const q = queue();
    const { id } = q.enqueue("render", "c1");
    q.fail(q.claim()!.lease, new Error("x".repeat(5000)), { retry: false });
    expect(q.get(id)!.error!.length).toBeLessThanOrEqual(2010);
  });

  it("parks over-budget jobs until resumed", () => {
    const q = queue();
    const { id } = q.enqueue("render", "c1");
    q.pauseOverBudget(q.claim()!.lease, "daily TTS cap reached");
    expect(q.claim()).toBeNull();
    expect(q.get(id)).toMatchObject({ state: "over_budget", error: "daily TTS cap reached" });
    expect(q.resume(id)).toBe(true);
    expect(q.claim()!.job).toMatchObject({ id, attempts: 1 });
  });

  it("release returns the job without consuming an attempt", () => {
    const q = queue();
    const { id } = q.enqueue("render", "c1");
    q.release(q.claim()!.lease);
    expect(q.get(id)).toMatchObject({ state: "queued", attempts: 0, leaseToken: null });
  });
});

describe("property: fencing under arbitrary interleavings", () => {
  type Op =
    | { t: "claim"; w: number }
    | { t: "beat"; w: number }
    | { t: "publish"; w: number }
    | { t: "complete"; w: number }
    | { t: "tick"; ms: number };

  const op = fc.oneof(
    fc.record({ t: fc.constant("claim" as const), w: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ t: fc.constant("beat" as const), w: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ t: fc.constant("publish" as const), w: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ t: fc.constant("complete" as const), w: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ t: fc.constant("tick" as const), ms: fc.integer({ min: 0, max: 2 * LEASE }) }),
  );

  it("only the current lease holder can write, and a job completes at most once", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops: Op[]) => {
        const d = withOutputs(openDb(":memory:"));
        try {
          const q = queue(d);
          const { id } = q.enqueue("render", "c1");
          const leases: (Lease | undefined)[] = [];
          let completions = 0;
          const current = () => q.get(id)!;

          for (const o of ops) {
            if (o.t === "tick") {
              clock += o.ms;
              continue;
            }
            if (o.t === "claim") {
              const c = q.claim();
              if (c) leases[o.w] = c.lease;
              continue;
            }
            const lease = leases[o.w];
            if (!lease) continue;
            const job = current();
            const owns = job.state === "running" && job.leaseToken === lease.token && job.leaseUntil! >= clock;
            if (o.t === "beat") {
              if (q.heartbeat(lease) !== owns) return false;
              continue;
            }
            try {
              if (o.t === "publish") markPublished(q, lease);
              else {
                q.complete(lease);
                completions++;
              }
              if (!owns) return false; // a non-owner wrote
            } catch (e) {
              if (!(e instanceof LeaseLostError) || owns) return false;
            }
          }
          const final = current();
          if (completions > 1) return false;
          if ((final.state === "done") !== (completions === 1)) return false;
          return final.attempts <= 3;
        } finally {
          d.close();
        }
      }),
      { numRuns: 300 },
    );
  });
});
