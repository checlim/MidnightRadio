import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { BudgetLedger, openDb } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeaseLostError, OverBudgetError, PermanentJobError } from "./errors.js";
import { JobQueue } from "./queue.js";
import { runOnce, runWorker, type JobHandler } from "./runner.js";

let db: DatabaseSync;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.close());

const q = (leaseMs = 1_000) => new JobQueue(db, { leaseMs, maxAttempts: 2 });

describe("runOnce", () => {
  it("returns false when there is no work for its handlers", async () => {
    const queue = q();
    queue.enqueue("other", "x");
    expect(await runOnce({ queue, handlers: { render: async () => {} } })).toBe(false);
  });

  it("completes a job and applies fenced writes", async () => {
    db.exec("CREATE TABLE test_outputs (job_id TEXT NOT NULL)");
    const queue = q();
    const { id } = queue.enqueue("render", "c1");
    const handler: JobHandler = async ({ publish, job }) => {
      publish((d) => d.prepare("INSERT INTO test_outputs (job_id) VALUES (?)").run(job.id));
    };
    expect(await runOnce({ queue, handlers: { render: handler } })).toBe(true);
    expect(queue.get(id)).toMatchObject({ state: "done", error: null });
    expect(db.prepare("SELECT job_id FROM test_outputs").all()).toEqual([{ job_id: id }]);
  });

  it("heartbeats keep a long job leased", async () => {
    const queue = q(120);
    const { id } = queue.enqueue("render", "c1");
    let stolen: unknown = "unset";
    await runOnce({
      queue,
      heartbeatMs: 20,
      handlers: {
        render: async () => {
          await sleep(400);
          stolen = queue.claim();
        },
      },
    });
    expect(stolen).toBeNull();
    expect(queue.get(id)!.state).toBe("done");
  });

  it("aborts the handler signal when the lease is lost and does not overwrite the new owner", async () => {
    const queue = q(100);
    const { id } = queue.enqueue("render", "c1");
    let sawAbort = false;
    await runOnce({
      queue,
      heartbeatMs: 10,
      handlers: {
        render: async ({ signal }) => {
          // Simulate another worker taking over: rotate the token directly.
          db.prepare("UPDATE jobs SET lease_token = 'other', lease_until = ? WHERE id = ?").run(Date.now() + 60_000, id);
          await sleep(60);
          sawAbort = signal.aborted && signal.reason instanceof LeaseLostError;
        },
      },
    });
    expect(sawAbort).toBe(true);
    expect(queue.get(id)).toMatchObject({ state: "running", leaseToken: "other" });
  });

  it("maps errors to retry, permanent failure and over_budget", async () => {
    const queue = q();
    const retry = queue.enqueue("a", "1");
    const perm = queue.enqueue("b", "1");
    const budget = queue.enqueue("c", "1");
    const errors: unknown[] = [];
    const handlers: Record<string, JobHandler> = {
      a: async () => {
        throw new Error("transient");
      },
      b: async () => {
        throw new PermanentJobError("bad epub");
      },
      c: async () => {
        throw new OverBudgetError("book budget exhausted");
      },
    };
    while (await runOnce({ queue, handlers, onError: (e) => errors.push(e) })) {}
    expect(queue.get(retry.id)).toMatchObject({ state: "failed", attempts: 2 });
    expect(queue.get(perm.id)).toMatchObject({ state: "failed", attempts: 1, error: "PermanentJobError: bad epub" });
    expect(queue.get(budget.id)).toMatchObject({ state: "over_budget", error: "book budget exhausted" });
    expect(errors).toHaveLength(4);
  });

  it("releases the job on shutdown without consuming an attempt", async () => {
    const queue = q();
    const { id } = queue.enqueue("render", "c1");
    const shutdown = new AbortController();
    await runOnce({
      queue,
      signal: shutdown.signal,
      handlers: {
        render: async ({ signal }) => {
          shutdown.abort();
          if (signal.aborted) throw signal.reason;
        },
      },
    });
    expect(queue.get(id)).toMatchObject({ state: "queued", attempts: 0 });
  });
});

describe("budget integration", () => {
  it("parks a job as over_budget without calling the provider, and fences reservations by lease", async () => {
    db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'T', 'h', 'ready', 0)").run();
    const queue = q();
    const ledger = new BudgetLedger(db, { dailyTtsChars: 100, dailyLlmTokens: 0, bookTtsCharCeiling: 60_000 });
    const { id } = queue.enqueue("render", "c1");
    let providerCalls = 0;
    const handler: JobHandler = async ({ assertLease }) => {
      for (const chars of [60, 60]) {
        await ledger.withReservation(
          { bookId: "b1", chapterId: null, ttsChars: chars },
          async () => {
            providerCalls++;
            return { value: undefined, usage: { ttsChars: chars } };
          },
          { fence: assertLease },
        );
      }
    };
    await runOnce({ queue, handlers: { render: handler } });
    expect(providerCalls).toBe(1);
    expect(queue.get(id)).toMatchObject({ state: "over_budget" });
    expect(queue.get(id)!.error).toMatch(/allowance is used up/);

    const stale = { jobId: "nope", token: "x" };
    expect(() =>
      ledger.reserve({ bookId: "b1", ttsChars: 1 }, {
        fence: () => {
          if (!queue.holds(stale)) throw new LeaseLostError(stale.jobId);
        },
      }),
    ).toThrow(LeaseLostError);
  });
});

describe("runWorker", () => {
  it("drains the queue and stops when aborted", async () => {
    const queue = q();
    for (const ref of ["c1", "c2", "c3"]) queue.enqueue("render", ref);
    const done: string[] = [];
    const stop = new AbortController();
    const worker = runWorker({
      queue,
      pollMs: 10,
      signal: stop.signal,
      handlers: { render: async ({ job }) => void done.push(job.refId) },
    });
    while (done.length < 3) await sleep(5);
    stop.abort();
    await worker;
    expect(done).toEqual(["c1", "c2", "c3"]);
  });
});
