import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { BudgetLedger, openDb } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderSegments, type RenderCache } from "@midnight-radio/tts";
import { LeaseLostError, OverBudgetError, PermanentJobError, isFatalJobError } from "./errors.js";
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

describe("resilience", () => {
  it("a throwing heartbeat is reported and does not crash the process", async () => {
    const queue = q();
    const { id } = queue.enqueue("render", "c1");
    queue.heartbeat = () => {
      throw new Error("database is locked");
    };
    const errors: unknown[] = [];
    await runOnce({
      queue,
      heartbeatMs: 5,
      onError: (e) => errors.push(e),
      handlers: { render: async () => void (await sleep(40)) },
    });
    expect(queue.get(id)!.state).toBe("done");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => (e as Error).message === "database is locked")).toBe(true);
  });

  it("does not claim when the shutdown signal is already aborted", async () => {
    const queue = q();
    const { id } = queue.enqueue("render", "c1");
    let ran = false;
    const worked = await runOnce({ queue, signal: AbortSignal.abort(), handlers: { render: async () => void (ran = true) } });
    expect(worked).toBe(false);
    expect(ran).toBe(false);
    expect(queue.get(id)).toMatchObject({ state: "queued", attempts: 0 });
  });

  it("runWorker keeps going after a claim error", async () => {
    const queue = q();
    queue.enqueue("render", "c1");
    queue.enqueue("render", "c2");
    const realClaim = queue.claim.bind(queue);
    let calls = 0;
    queue.claim = (kinds) => {
      if (++calls === 1) throw new Error("database is locked");
      return realClaim(kinds);
    };
    const done: string[] = [];
    const errors: unknown[] = [];
    const stop = new AbortController();
    const worker = runWorker({
      queue,
      pollMs: 5,
      signal: stop.signal,
      onError: (e) => errors.push(e),
      handlers: { render: async ({ job }) => void done.push(job.refId) },
    });
    while (done.length < 2) await sleep(5);
    stop.abort();
    await worker;
    expect(done).toEqual(["c1", "c2"]);
    expect((errors[0] as Error).message).toBe("database is locked");
  });

  it("a throwing onError reporter cannot stop the worker", async () => {
    const queue = q();
    const { id } = queue.enqueue("render", "c1");
    await runOnce({
      queue,
      onError: () => {
        throw new Error("logger down");
      },
      handlers: {
        render: async () => {
          throw new PermanentJobError("bad");
        },
      },
    });
    expect(queue.get(id)!.state).toBe("failed");
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

describe("isFatalJobError with renderSegments", () => {
  it("stops a render once the lease is lost instead of recording the line as failed and moving on", async () => {
    expect(isFatalJobError(new LeaseLostError("j1"))).toBe(true);
    expect(isFatalJobError(new Error("boom"))).toBe(false);
    const rendered: string[] = [];
    const cache = {
      render: async (req: { text: string }) => {
        if (req.text === "two") throw new LeaseLostError("j1");
        rendered.push(req.text);
        return { key: req.text, path: `/x/${req.text}.wav`, durationMs: 1, source: "rendered" as const };
      },
    };
    const lines = ["one", "two", "three"].map((text, i) => ({ id: String(i), voiceId: "v", text }));
    const run = (isFatal?: (err: unknown) => boolean) => renderSegments(lines, { cache: cache as unknown as RenderCache, parallelism: 1, delay: async () => {}, ...(isFatal ? { isFatal } : {}) });
    await expect(run(isFatalJobError)).rejects.toBeInstanceOf(LeaseLostError);
    expect(rendered).toEqual(["one"]);
    // Without it, the lost lease is just a failed line and the run carries on rendering for a job it no longer owns.
    rendered.length = 0;
    const outcomes = await run();
    expect(outcomes.map((o) => o.status)).toEqual(["rendered", "failed", "rendered"]);
    expect(rendered).toEqual(["one", "three"]);
  });
});

describe("cancellation", () => {
  it("aborts a running handler at the next heartbeat and fails the job without a retry", async () => {
    const queue = q(1_000);
    const { id } = queue.enqueue("render", "c1");
    let reason: unknown;
    const done = runOnce({
      queue,
      heartbeatMs: 20,
      handlers: {
        render: async ({ signal }) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          reason = signal.reason;
          throw new Error("stopped part-way");
        },
      },
    });
    await sleep(50);
    expect(queue.requestCancel(id)).toBe(true);
    await done;
    expect((reason as Error).name).toBe("JobCancelledError");
    expect(queue.get(id)).toMatchObject({ state: "failed", error: "cancelled by a person", attempts: 1 });
  });
});
