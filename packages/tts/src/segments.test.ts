import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetExceededError, BudgetLedger, openDb } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TtsError } from "./provider.js";
import { RenderCache, type RenderCacheOptions } from "./render-cache.js";
import { backoffMs, planRender, renderSegments, type RenderSegment, type RenderSegmentsOptions, type RetryInfo, type SegmentOutcome } from "./segments.js";
import { ProbeProvider } from "./test-support/probe-provider.js";
import { validateWav } from "./wav.js";

let dir: string;
let provider: ProbeProvider;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mr-segments-"));
  provider = new ProbeProvider();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const makeCache = (opts: Partial<RenderCacheOptions> = {}) => new RenderCache({ dir, provider, ...opts });
const seg = (id: string, text: string, voiceId = "stub-f1"): RenderSegment => ({ id, voiceId, text });
const lines = (n: number) => Array.from({ length: n }, (_, i) => seg(`s${i}`, `Line number ${i}.`));
const unavailable = () => new TtsError("unavailable", "local audio service is not running", false, true);
const timeout = () => new TtsError("timeout", "no answer from the local audio service", true, true);

/** Run with instant, recorded backoff. */
async function run(segments: RenderSegment[], opts: Partial<RenderSegmentsOptions> = {}) {
  const waits: number[] = [];
  const retries: RetryInfo[] = [];
  const done: SegmentOutcome[] = [];
  const outcomes = await renderSegments(segments, {
    cache: makeCache(),
    delay: async (ms) => void waits.push(ms),
    onRetry: (r) => retries.push(r),
    onSegment: (o) => void done.push(o),
    ...opts,
  });
  return { outcomes, waits, retries, done };
}
const failed = (o: SegmentOutcome) => (o.status === "failed" ? o : undefined);
const caught = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("backoffMs", () => {
  it("doubles from the base up to the cap", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 500, 1_200))).toEqual([500, 1_000, 1_200, 1_200]);
  });
});

describe("rendering a chapter's lines", () => {
  it("renders every line, reports each as it finishes, and returns outcomes in input order", async () => {
    const { outcomes, done } = await run(lines(5));
    expect(outcomes.map((o) => [o.id, o.status, o.attempts])).toEqual(lines(5).map((s) => [s.id, "rendered", 1]));
    expect(done.map((o) => o.id).sort()).toEqual(outcomes.map((o) => o.id).sort());
    for (const o of outcomes) {
      if (o.status === "failed") throw new Error("unexpected failure");
      expect(validateWav(await readFile(o.result.path)).frames).toBeGreaterThan(0);
    }
  });

  it("serves a second run entirely from the cache", async () => {
    const cache = makeCache();
    await run(lines(4), { cache });
    const second = await run(lines(4), { cache });
    expect(second.outcomes.every((o) => o.status === "cached")).toBe(true);
    expect(provider.calls).toBe(4);
  });

  it("renders identical lines once", async () => {
    const { outcomes } = await run([seg("a", "Same words."), seg("b", "Same words."), seg("c", "Same words.")], { parallelism: 3 });
    expect(provider.calls).toBe(1);
    expect(outcomes.map((o) => o.status).every((s) => s !== "failed")).toBe(true);
  });

  it("handles an empty chapter and refuses duplicate ids", async () => {
    expect((await run([])).outcomes).toEqual([]);
    await expect(run([seg("a", "One."), seg("a", "Two.")])).rejects.toThrow(/duplicate segment id "a"/);
    expect(provider.calls).toBe(0);
  });
});

describe("retries with exponential backoff (Req 5.3)", () => {
  it("retries three times, waiting 1 s, 2 s and 4 s, then marks the line failed", async () => {
    provider.failWith = unavailable();
    const { outcomes, waits, retries } = await run([seg("a", "Hello there.")]);
    expect(provider.calls).toBe(4); // the first try and three retries
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(retries.map((r) => [r.attempt, r.waitMs])).toEqual([[1, 1_000], [2, 2_000], [3, 4_000]]);
    expect(outcomes[0]).toEqual({
      id: "a",
      status: "failed",
      attempts: 4,
      error: { kind: "unavailable", message: "local audio service is not running", retryable: true },
    });
  });

  it("stops retrying as soon as a render succeeds", async () => {
    provider.failure = (_req, call) => (call <= 2 ? timeout() : undefined);
    const { outcomes, waits } = await run([seg("a", "Hello there.")]);
    expect(waits).toEqual([1_000, 2_000]);
    expect(outcomes[0]).toMatchObject({ status: "rendered", attempts: 3 });
  });

  it("honours the retry count, the base delay and the cap", async () => {
    provider.failWith = timeout();
    expect((await run([seg("a", "Hi.")], { maxRetries: 0 })).waits).toEqual([]);
    provider.calls = 0;
    const custom = await run([seg("a", "Hi.")], { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 1_500 });
    expect(custom.waits).toEqual([500, 1_000, 1_500, 1_500, 1_500]);
    expect(provider.calls).toBe(6);
  });

  it("retries audio the model got wrong, since another take may be fine", async () => {
    provider.output = () => Buffer.from("not a wav");
    const { outcomes, waits } = await run([seg("a", "Hello there.")]);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(failed(outcomes[0]!)?.error.kind).toBe("invalid_output");
  });

  it("does not retry what cannot succeed: an unknown voice, an invalid line, or a bug", async () => {
    const r = await run([seg("a", "Hello.", "nobody"), seg("b", "  "), seg("c", "Fine line.")]);
    expect(r.waits).toEqual([]);
    expect(r.outcomes.map((o) => [o.status, o.attempts])).toEqual([["failed", 1], ["failed", 1], ["rendered", 1]]);
    expect(failed(r.outcomes[0]!)?.error).toMatchObject({ kind: "rejected", retryable: false });

    provider.failure = (req) => (req.text === "Boom." ? new RangeError("a bug in the provider") : undefined);
    const bug = await run([seg("x", "Boom."), seg("y", "Fine too.")]);
    expect(bug.waits).toEqual([]);
    expect(failed(bug.outcomes[0]!)?.error).toMatchObject({ kind: "internal", retryable: false });
    expect(bug.outcomes[1]!.status).toBe("rendered");
  });
});

describe("a failing line does not take the others down (Req 5.3)", () => {
  it("records only that line as failed, keeps everything already rendered, and a rerun renders only the failure", async () => {
    const cache = makeCache();
    provider.failure = (req) => (req.text === "Line number 2." ? unavailable() : undefined);
    const first = await run(lines(5), { cache });
    expect(first.outcomes.map((o) => o.status)).toEqual(["rendered", "rendered", "failed", "rendered", "rendered"]);
    expect(first.done).toHaveLength(5); // the failure is reported like any other result
    expect((await readdir(dir)).filter((f) => f.endsWith(".wav"))).toHaveLength(4);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    provider.failure = undefined;
    provider.calls = 0;
    const second = await run(lines(5), { cache });
    expect(second.outcomes.map((o) => o.status)).toEqual(["cached", "cached", "rendered", "cached", "cached"]);
    expect(provider.calls).toBe(1);
  });

  it("keeps rendering the other lines while one waits to retry", async () => {
    provider.failure = (req, call) => (req.text === "Line number 0." && call === 1 ? timeout() : undefined);
    const { outcomes, waits } = await run(lines(3), { parallelism: 1 });
    expect(waits).toEqual([1_000]);
    expect(outcomes.map((o) => o.status)).toEqual(["rendered", "rendered", "rendered"]);
    expect(outcomes[0]).toMatchObject({ attempts: 2 });
  });
});

describe("failures that stop the whole job", () => {
  it("stops on an exhausted budget, after reporting the lines already rendered, without retrying", async () => {
    let renders = 0;
    const cache = makeCache({
      around: (_info, call) => {
        if (++renders > 2) throw new BudgetExceededError("daily_tts", "Today's voice rendering allowance is used up.");
        return call();
      },
    });
    const done: string[] = [];
    const error = await caught(renderSegments(lines(5), { cache, parallelism: 1, delay: async () => undefined, onSegment: (o) => void done.push(o.id) }));
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(done).toEqual(["s0", "s1"]);
    expect(provider.calls).toBe(2); // nothing rendered after the refusal, and no retry of it
    expect((await readdir(dir)).filter((f) => f.endsWith(".wav"))).toHaveLength(2); // finished work is kept
  });

  it("stops on an error the caller marks fatal (such as a lost job lease)", async () => {
    class LeaseLost extends Error {}
    const cache = makeCache({
      around: () => {
        throw new LeaseLost("lease lost");
      },
    });
    const done: SegmentOutcome[] = [];
    const error = await caught(renderSegments(lines(3), { cache, parallelism: 1, isFatal: (e) => e instanceof LeaseLost, onSegment: (o) => void done.push(o) }));
    expect(error).toBeInstanceOf(LeaseLost);
    expect(done).toEqual([]); // not recorded as a failed line
    expect(provider.calls).toBe(0);
  });

  it("stops if recording a finished line fails", async () => {
    let calls = 0;
    const error = await caught(
      renderSegments(lines(4), {
        cache: makeCache(),
        parallelism: 1,
        onSegment: () => {
          if (++calls === 2) throw new Error("database is locked");
        },
      }),
    );
    expect((error as Error).message).toBe("database is locked");
    expect(provider.calls).toBe(2);
  });

  it("stops promptly when aborted, including during a backoff wait", async () => {
    provider.failWith = unavailable();
    const ctrl = new AbortController();
    const started = Date.now();
    const running = renderSegments([seg("a", "Hello there.")], { cache: makeCache(), signal: ctrl.signal, baseDelayMs: 10_000 });
    setTimeout(() => ctrl.abort(), 60);
    expect(await caught(running)).toMatchObject({ kind: "aborted" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(provider.calls).toBe(1);
  });

  it("does not record a line as failed when it was aborted mid-render, so it renders again next time", async () => {
    provider.delayMs = 300;
    const ctrl = new AbortController();
    const reported: SegmentOutcome[] = [];
    const cache = makeCache();
    const running = renderSegments(lines(3), { cache, parallelism: 3, signal: ctrl.signal, onSegment: (o) => void reported.push(o) });
    setTimeout(() => ctrl.abort(), 60);
    expect(await caught(running)).toMatchObject({ kind: "aborted" });
    expect(reported).toEqual([]); // nothing finished, and nothing is marked failed
    expect((await readdir(dir)).filter((f) => f.endsWith(".wav"))).toEqual([]);

    provider.delayMs = 0;
    provider.calls = 0;
    const again = await run(lines(3), { cache });
    expect(again.outcomes.map((o) => o.status)).toEqual(["rendered", "rendered", "rendered"]); // the aborted lines are still to do
  });

  it("returns nothing for lines it never started once aborted, but keeps those finished", async () => {
    const ctrl = new AbortController();
    const done: string[] = [];
    const running = renderSegments(lines(6), {
      cache: makeCache(),
      parallelism: 1,
      signal: ctrl.signal,
      onSegment: (o) => {
        done.push(o.id);
        if (done.length === 2) ctrl.abort();
      },
    });
    expect(await caught(running)).toMatchObject({ kind: "aborted" });
    expect(done).toEqual(["s0", "s1"]);
    expect(provider.calls).toBe(2);
  });
});

describe("retries and the spend ledger", () => {
  const setup = (cap: number) => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'T', 'h', 'ready', 0)").run();
    const ledger = new BudgetLedger(db, { dailyTtsChars: cap, dailyLlmTokens: 0, bookTtsCharCeiling: 60_000 });
    const around: RenderCacheOptions["around"] = (info, call) =>
      ledger.withReservation({ bookId: "b1", ttsChars: info.chars }, async () => ({ value: await call(), usage: { ttsChars: info.chars } }));
    return { db, ledger, around };
  };

  it("attempts that never started cost nothing, however many are retried", async () => {
    const { db, ledger, around } = setup(1_000);
    provider.failWith = unavailable();
    const { outcomes } = await run([seg("a", "Hello there.")], { cache: makeCache({ around }) });
    expect(outcomes[0]!.status).toBe("failed");
    expect(ledger.daySpend().ttsChars).toBe(0);
    db.close();
  });

  it("attempts that may have used render time stay counted, so retries cannot overspend", async () => {
    const { db, ledger, around } = setup(40); // "Hello there." is 12 characters; four timed-out attempts would be 48
    provider.failWith = timeout();
    const error = await caught(renderSegments([seg("a", "Hello there.")], { cache: makeCache({ around }), delay: async () => undefined }));
    expect(error).toBeInstanceOf(BudgetExceededError); // the fourth attempt is refused, and stops the job
    expect(ledger.daySpend().ttsChars).toBe(36);
    expect(provider.calls).toBe(3);
    db.close();
  });
});

describe("no secrets in what is reported", () => {
  it("redacts and shortens error text in outcomes and retry notices", async () => {
    provider.failWith = new TtsError("unavailable", `service said: Authorization: Bearer abcdef1234567890 and key sk-live-AbCdEf0123456789xyz ${"y".repeat(400)}`, false, true);
    const { outcomes, retries } = await run([seg("a", "Hello there.")], { secrets: ["abcdef1234567890"] });
    const text = JSON.stringify({ outcomes, retries });
    expect(text).not.toContain("abcdef1234567890");
    expect(text).not.toContain("sk-live");
    expect(failed(outcomes[0]!)!.error.message.length).toBeLessThanOrEqual(301);
    expect(retries).toHaveLength(3);
  });

  it("never includes the request text in a failure it reports for another reason", async () => {
    provider.failure = () => new TtsError("unavailable", "service down", false, true);
    const { outcomes } = await run([seg("a", "A private line of dialogue.")]);
    expect(JSON.stringify(outcomes)).not.toContain("private line");
  });
});

describe("planRender: the report before rendering starts (Req 5.6)", () => {
  it("counts characters and estimates render time for what is not already cached", async () => {
    const cache = makeCache();
    await cache.render({ voiceId: "stub-f1", text: "Another line." }); // 13 characters, already published
    provider.calls = 0;
    const plan = await planRender(cache, [
      seg("a1", "Hello there."), //   12
      seg("a2", "Hello there."), //   12, an identical line: rendered once
      seg("b", "Another line."), //   13, cached
      seg("c", "No such voice.", "nobody"), // a problem
      seg("d", "Fresh line."), //     11
    ]);
    expect(plan).toEqual({
      segments: 5,
      totalChars: 12 + 12 + 13 + 14 + 11,
      uniqueRenders: 3,
      cachedRenders: 1,
      toRender: 2,
      cachedChars: 13,
      toRenderChars: 12 + 11,
      estimatedRenderMs: Math.ceil(12 / 20) + Math.ceil(11 / 20),
      problems: [{ id: "c", message: expect.stringMatching(/unknown voice/) }],
    });
    expect(provider.calls).toBe(0); // planning renders nothing
    expect((await readdir(dir)).filter((f) => f.endsWith(".wav"))).toHaveLength(1);
  });

  it("reports nothing left to render, and no estimate, once everything is cached", async () => {
    const cache = makeCache();
    await run(lines(3), { cache });
    expect(await planRender(cache, lines(3))).toMatchObject({ toRender: 0, toRenderChars: 0, cachedRenders: 3, estimatedRenderMs: 0, problems: [] });
  });

  it("handles an empty chapter", async () => {
    expect(await planRender(makeCache(), [])).toEqual({
      segments: 0,
      totalChars: 0,
      uniqueRenders: 0,
      cachedRenders: 0,
      toRender: 0,
      cachedChars: 0,
      toRenderChars: 0,
      estimatedRenderMs: 0,
      problems: [],
    });
  });

  it("grows the estimate with the amount left to render", async () => {
    const cache = makeCache();
    const short = await planRender(cache, [seg("a", "x".repeat(100))]);
    const long = await planRender(cache, [seg("a", "x".repeat(100)), seg("b", "y".repeat(2_000))]);
    expect(long.estimatedRenderMs).toBeGreaterThan(short.estimatedRenderMs);
  });
});
