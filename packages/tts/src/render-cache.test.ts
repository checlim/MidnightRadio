import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BudgetExceededError, BudgetLedger, openDb } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderCacheKey } from "./cache-key.js";
import { TtsError, type SynthesisRequest } from "./provider.js";
import { RenderCache, type RenderCacheOptions } from "./render-cache.js";
import { ProbeProvider } from "./test-support/probe-provider.js";
import { runChild } from "./test-support/run-child.js";
import { encodeWav, validateWav } from "./wav.js";

let dir: string;
let provider: ProbeProvider;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mr-render-"));
  provider = new ProbeProvider();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const make = (opts: Partial<RenderCacheOptions> = {}) => new RenderCache({ dir, provider, ...opts });
const say = (text: string, voiceId = "stub-f1"): SynthesisRequest => ({ voiceId, text });
const files = async () => (await readdir(dir)).sort();
const keyOf = (req: SynthesisRequest) => renderCacheKey(provider, req);
const tempName = (key: string, job = "job-1", nonce = "0123456789ab") => `${key}.${job}.${nonce}.wav.tmp`;
const caught = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("render and hit (Req 5.2)", () => {
  it("publishes <key>.wav once, then serves it without rendering", async () => {
    const cache = make();
    const first = await cache.render(say("Good evening, listeners."));
    expect(first).toMatchObject({ cached: false, key: keyOf(say("Good evening, listeners.")) });
    expect(first.path).toBe(join(dir, `${first.key}.wav`));
    expect(validateWav(await readFile(first.path))).toEqual(first.info);
    expect(await files()).toEqual([`${first.key}.wav`]); // no temp file left behind

    const second = await cache.render(say("Good evening, listeners."));
    expect(second).toMatchObject({ cached: true, key: first.key, path: first.path });
    expect(provider.calls).toBe(1);
    expect(cache.stats).toEqual({ hits: 1, renders: 1, repaired: 0 });
  });

  it("is shared by new cache objects on the same directory, as after a restart", async () => {
    await make().render(say("Hello."));
    const again = await make().render(say("Hello."));
    expect(again.cached).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it("keeps the exact text: a trailing space is a different request", async () => {
    const cache = make();
    await cache.render(say("Hello there."));
    const other = await cache.render(say("Hello there. "));
    expect(other.cached).toBe(false);
    expect(await files()).toHaveLength(2);
  });

  it("lookup finds published audio and never renders", async () => {
    const cache = make();
    expect(await cache.lookup(say("Hello."))).toBeUndefined();
    await cache.render(say("Hello."));
    expect(await cache.lookup(say("Hello."))).toMatchObject({ cached: true });
    expect(await cache.lookup(say("Goodbye."))).toBeUndefined();
    expect(provider.calls).toBe(1);
  });

  it("refuses invalid requests and unknown voices before doing any work", async () => {
    const cache = make();
    expect(await caught(cache.render(say("  ")))).toMatchObject({ kind: "rejected", billed: false, retryable: false });
    expect(await caught(cache.render(say("Hi", "nobody")))).toMatchObject({ kind: "rejected" });
    expect(await caught(cache.render({ voiceId: "stub-f1", text: "Hi", extra: 1 } as never))).toMatchObject({ kind: "rejected" });
    expect(provider.calls).toBe(0);
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});

describe("only validated audio counts as a hit", () => {
  const req = say("Hello there.");
  const damage: [string, (good: Buffer) => Buffer][] = [
    ["a truncated file", (g) => g.subarray(0, g.length - 10)],
    ["an empty file", () => Buffer.alloc(0)],
    ["garbage", () => Buffer.from("this is not audio at all, just some text".repeat(5))],
    ["a file with an extra byte", (g) => Buffer.concat([g, Buffer.from([0])])],
    ["silence", () => encodeWav(new Int16Array(2_000))],
    ["audio at the wrong sample rate", () => encodeWav(Int16Array.from({ length: 2_000 }, (_, i) => (i % 50) * 100), 44_100)],
  ];

  it.each(damage)("discards %s and renders again", async (_label, corrupt) => {
    const cache = make();
    const first = await cache.render(req);
    await writeFile(first.path, corrupt(await readFile(first.path)));

    const again = await cache.render(req);
    expect(again.cached).toBe(false);
    expect(provider.calls).toBe(2);
    expect(cache.stats.repaired).toBe(1);
    expect(validateWav(await readFile(again.path)).frames).toBeGreaterThan(0);
    expect(await files()).toEqual([`${first.key}.wav`]);
  });

  it("never treats temp or partial files as hits", async () => {
    const cache = make();
    const key = keyOf(req);
    const complete = encodeWav(Int16Array.from({ length: 2_000 }, (_, i) => (i % 50) * 100));
    await writeFile(join(dir, tempName(key)), complete); // a complete, valid WAV, but under a temp name
    await writeFile(join(dir, `${key}.wav.partial`), complete);
    await writeFile(join(dir, `${key}.wav.tmp`), complete);
    expect(await cache.lookup(req)).toBeUndefined();
    const result = await cache.render(req);
    expect(result.cached).toBe(false);
    expect(provider.calls).toBe(1);
  });
});

describe("failed renders publish nothing", () => {
  it("leaves no file when the provider fails, and the next attempt can succeed", async () => {
    const cache = make();
    provider.failWith = new TtsError("unavailable", "local audio service is not running", false, true);
    expect(await caught(cache.render(say("Hello.")))).toBe(provider.failWith);
    await expect(readdir(dir)).resolves.toEqual([]);

    provider.failWith = undefined;
    expect((await cache.render(say("Hello."))).cached).toBe(false);
    expect(provider.calls).toBe(2);
  });

  it.each([
    ["garbage bytes", () => Buffer.from("RIFFnope")],
    ["silent audio", () => encodeWav(new Int16Array(500))],
    ["audio at the wrong rate", () => encodeWav(Int16Array.from({ length: 500 }, (_, i) => i + 1), 16_000)],
    ["a truncated WAV", () => encodeWav(Int16Array.from({ length: 500 }, (_, i) => i + 1)).subarray(0, 300)],
  ])("rejects %s from the model and publishes nothing", async (_label, output) => {
    provider.output = output;
    const e = await caught(make().render(say("Hello.")));
    expect(e).toBeInstanceOf(TtsError);
    expect(e).toMatchObject({ kind: "invalid_output", billed: true, retryable: true });
    expect((e as TtsError).message).toMatch(/voice model produced unusable audio/); // caught before anything is written
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("removes its temp file and publishes nothing when a step after the write fails", async () => {
    const cache = make({
      hooks: {
        afterTempWritten: async () => {
          expect((await files()).some((f) => f.endsWith(".wav.tmp"))).toBe(true); // it was there
          throw new Error("disk full");
        },
      },
    });
    await expect(cache.render(say("Hello."))).rejects.toThrow("disk full");
    await expect(readdir(dir)).resolves.toEqual([]);
    expect(cache.stats.renders).toBe(0);
  });

  it("lets unexpected errors through unchanged", async () => {
    provider.failWith = new RangeError("a bug in the provider");
    expect(await caught(make().render(say("Hello.")))).toBeInstanceOf(RangeError);
  });
});

describe("coalescing and concurrency", () => {
  it("shares one render between identical concurrent requests", async () => {
    provider.delayMs = 50;
    const cache = make();
    const results = await Promise.all(Array.from({ length: 6 }, () => cache.render(say("Same line."))));
    expect(provider.calls).toBe(1);
    expect(new Set(results.map((r) => r.path)).size).toBe(1);
    expect(results.every((r) => r.cached === false)).toBe(true);
    expect(cache.stats).toMatchObject({ renders: 1 });
  });

  it("fails every waiter together, then lets a retry render afresh", async () => {
    provider.delayMs = 30;
    provider.failWith = new TtsError("timeout", "too slow", true, true);
    const cache = make();
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => cache.render(say("Same line."))));
    expect(outcomes.every((o) => o.status === "rejected" && o.reason === provider.failWith)).toBe(true);
    expect(provider.calls).toBe(1);

    provider.failWith = undefined;
    expect((await cache.render(say("Same line."))).cached).toBe(false);
    expect(provider.calls).toBe(2);
  });

  it.each([1, 2, 3])("runs at most %i distinct renders at once", async (limit) => {
    provider.delayMs = 25;
    const cache = make({ concurrency: limit });
    await Promise.all(Array.from({ length: 8 }, (_, i) => cache.render(say(`Line number ${i}.`))));
    expect(provider.calls).toBe(8);
    expect(provider.maxInFlight).toBe(limit);
    expect(await files()).toHaveLength(8);
  });

  it("defaults to two at a time", async () => {
    provider.delayMs = 25;
    const cache = make();
    await Promise.all(Array.from({ length: 6 }, (_, i) => cache.render(say(`Line ${i}.`))));
    expect(provider.maxInFlight).toBe(2);
  });

  it("serves cache hits without waiting for a render slot", async () => {
    const cache = make({ concurrency: 1 });
    await cache.render(say("Already rendered."));
    provider.delayMs = 400;
    const slow = cache.render(say("Slow new line."));
    await sleep(30);
    expect(provider.inFlight).toBe(1); // the only slot is busy
    expect((await cache.render(say("Already rendered."))).cached).toBe(true); // yet the hit returns at once
    expect(provider.inFlight).toBe(1);
    await slow;
  });

  it("rejects a bad concurrency setting", () => {
    expect(() => make({ concurrency: 0 })).toThrow(/positive integer/);
  });
});

describe("aborting", () => {
  it("does nothing if already aborted", async () => {
    const e = await caught(make().render(say("Hello."), { signal: AbortSignal.abort() }));
    expect(e).toMatchObject({ kind: "aborted", billed: false, retryable: false });
    expect(provider.calls).toBe(0);
  });

  it("drops a request that is still waiting for a slot", async () => {
    provider.delayMs = 150;
    const cache = make({ concurrency: 1 });
    const first = cache.render(say("First line."));
    await sleep(20);
    const ctrl = new AbortController();
    const queued = cache.render(say("Second line."), { signal: ctrl.signal });
    await sleep(20);
    ctrl.abort();
    expect(await caught(queued)).toMatchObject({ kind: "aborted" });
    await first;
    expect(provider.calls).toBe(1); // the aborted request never reached the model
  });

  it("keeps rendering for the callers that remain, and stops when none remain", async () => {
    provider.delayMs = 200;
    const cache = make();
    const a = new AbortController();
    const b = new AbortController();
    const waitA = cache.render(say("Shared line."), { signal: a.signal });
    const waitB = cache.render(say("Shared line."), { signal: b.signal });
    await sleep(30);
    a.abort();
    expect(await caught(waitA)).toMatchObject({ kind: "aborted" });
    expect((await waitB).cached).toBe(false); // B still gets the audio
    expect(provider.sawAbort).toBe(false);

    provider.delayMs = 400;
    const c = new AbortController();
    const d = new AbortController();
    const waitC = cache.render(say("Another line."), { signal: c.signal });
    const waitD = cache.render(say("Another line."), { signal: d.signal });
    await sleep(30);
    c.abort();
    d.abort();
    await Promise.all([caught(waitC), caught(waitD)]);
    await sleep(50);
    expect(provider.sawAbort).toBe(true); // nobody left to hear it, so the model was told to stop
    expect(await cache.lookup(say("Another line."))).toBeUndefined();
  });
});

describe("budget hook (Req 8.2)", () => {
  it("wraps each real render, and only those", async () => {
    const seen: { chars: number; voiceId: string }[] = [];
    provider.delayMs = 30;
    const cache = make({ around: (info, call) => (seen.push(info), call()) });
    await Promise.all([cache.render(say("Hello there.")), cache.render(say("Hello there.")), cache.render(say("Another."))]);
    await cache.render(say("Hello there.")); // a hit
    expect(seen).toEqual([
      { chars: 12, voiceId: "stub-f1" },
      { chars: 8, voiceId: "stub-f1" },
    ]);
  });

  it("refuses to render, and publishes nothing, when the hook throws", async () => {
    const cache = make({
      around: async () => {
        throw new Error("over budget");
      },
    });
    await expect(cache.render(say("Hello."))).rejects.toThrow("over budget");
    expect(provider.calls).toBe(0);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("re-checks the cache once it has a slot, and does not charge for audio another writer published meanwhile", async () => {
    provider.delayMs = 150;
    const reserved: number[] = [];
    const cache = make({ concurrency: 1, around: (info, call) => (reserved.push(info.chars), call()) });
    const first = cache.render(say("First line."));
    await sleep(20);
    const queued = cache.render(say("Second line.")); // waits for the only slot
    await sleep(20);
    // Another process publishes the second line while it is queued.
    await writeFile(join(dir, `${keyOf(say("Second line."))}.wav`), encodeWav(Int16Array.from({ length: 2_000 }, (_, i) => (i % 50) * 100)));
    await first;
    expect(await queued).toMatchObject({ cached: true });
    expect(provider.calls).toBe(1);
    expect(reserved).toEqual([11]); // only "First line."
  });

  describe("with the real spend ledger", () => {
    const setup = (cap: number) => {
      const db = openDb(":memory:");
      db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'T', 'h', 'ready', 0)").run();
      const ledger = new BudgetLedger(db, { dailyTtsChars: cap, dailyLlmTokens: 0, bookTtsCharCeiling: 60_000 });
      const around: RenderCacheOptions["around"] = (info, call) =>
        ledger.withReservation({ bookId: "b1", ttsChars: info.chars }, async () => ({ value: await call(), usage: { ttsChars: info.chars } }));
      return { db, ledger, around };
    };

    it("reserves each render's characters, refuses what does not fit, and still serves hits", async () => {
      const { db, ledger, around } = setup(20);
      const cache = make({ around });
      await cache.render(say("Hello there.")); // 12 chars
      expect(ledger.daySpend().ttsChars).toBe(12);

      await expect(cache.render(say("A second line."))).rejects.toBeInstanceOf(BudgetExceededError); // 14 more would pass 20
      expect(provider.calls).toBe(1); // the model was never asked
      expect((await cache.render(say("Hello there."))).cached).toBe(true); // hits cost nothing
      expect(ledger.daySpend().ttsChars).toBe(12);
      db.close();
    });

    it("releases the reservation when the service never started the render, and keeps it after a timeout", async () => {
      const { db, ledger, around } = setup(1_000);
      const cache = make({ around });
      provider.failWith = new TtsError("unavailable", "service not running", false, true);
      await caught(cache.render(say("Hello there.")));
      expect(ledger.daySpend().ttsChars).toBe(0);

      provider.failWith = new TtsError("timeout", "no answer", true, true);
      await caught(cache.render(say("Hello there.")));
      expect(ledger.daySpend().ttsChars).toBe(12); // time may have been spent: stays counted
      db.close();
    });
  });
});

describe("sweeping abandoned temp files", () => {
  const OLD = new Date(Date.now() - 3_600_000);
  const place = async (name: string, mtime?: Date) => {
    await writeFile(join(dir, name), "x");
    if (mtime) await utimes(join(dir, name), mtime, mtime);
  };
  let key: string;
  beforeEach(() => {
    key = keyOf(say("Hello.")); // needs the provider that the outer beforeEach creates
  });

  it("removes only old temp files whose writer is not active", async () => {
    await place(tempName(key, "job-dead"), OLD);
    await place(tempName(key, "job-alive", "aaaaaaaaaaaa"), OLD);
    await place(tempName(key, "job-new", "bbbbbbbbbbbb")); // fresh
    const removed = await make().sweepAbandoned({ isJobActive: (id) => id === "job-alive" });
    expect(removed).toEqual([tempName(key, "job-dead")]);
    expect(await files()).toEqual([tempName(key, "job-alive", "aaaaaaaaaaaa"), tempName(key, "job-new", "bbbbbbbbbbbb")].sort());
  });

  it("never touches anything that is not one of its temp files", async () => {
    await place(`${key}.wav`, OLD);
    await place("notes.txt", OLD);
    await place("README.wav.tmp", OLD);
    await place(`${key}.job-1.zzzzzzzzzzzz.wav.tmp`, OLD); // nonce is not hex
    await place(`${key}.wav.tmp`, OLD);
    await place(`${key.slice(1)}.job-1.0123456789ab.wav.tmp`, OLD); // key too short
    expect(await make().sweepAbandoned({ olderThanMs: 0 })).toEqual([]);
    expect(await files()).toHaveLength(6);
  });

  it("leaves a temp file this process is still writing", async () => {
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atTemp = new Promise<void>((r) => (reached = r));
    const cache = make({ hooks: { afterTempWritten: () => (reached(), paused) } });
    const render = cache.render(say("Hello."), { jobId: "job-live" });
    await atTemp;
    const during = (await files()).filter((f) => f.endsWith(".wav.tmp"));
    expect(during).toHaveLength(1);
    expect(during[0]).toMatch(new RegExp(`^${key}\\.job-live\\.[0-9a-f]{12}\\.wav\\.tmp$`));
    expect(await cache.sweepAbandoned({ olderThanMs: 0 })).toEqual([]); // ours, so untouched
    release();
    await render;
    expect(await files()).toEqual([`${key}.wav`]);
  });

  it("is a no-op when the cache directory does not exist yet", async () => {
    expect(await make({ dir: join(dir, "missing") }).sweepAbandoned()).toEqual([]);
  });
});

describe("crash recovery: processes killed with SIGKILL", () => {
  const text = "The night air is chill.";
  const req = say(text);
  const isTemp = (f: string) => f.endsWith(".wav.tmp");

  it("killed after the file was written but before the rename: no hit, then re-render, then the stale temp is swept", async () => {
    const child = await runChild("crash-child.ts", [dir, "before-rename", text]);
    expect(child.signal).toBe("SIGKILL");
    expect(child.stdout).toContain("KILLING");

    const key = keyOf(req);
    const left = await files();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(new RegExp(`^${key}\\.job-crash\\.[0-9a-f]{12}\\.wav\\.tmp$`)); // a temp file only, no <key>.wav

    const cache = make();
    expect(await cache.lookup(req)).toBeUndefined(); // the temp file is not a hit, though its audio is complete
    expect((await cache.render(req)).cached).toBe(false);
    expect(provider.calls).toBe(1);
    expect((await files()).filter(isTemp)).toHaveLength(1); // render does not delete another writer's file

    expect(await cache.sweepAbandoned({ olderThanMs: 0 })).toHaveLength(1);
    expect(await files()).toEqual([`${key}.wav`]);
  });

  it("killed after the rename, before anything recorded it: the orphan is valid and reused on resume", async () => {
    const child = await runChild("crash-child.ts", [dir, "after-rename", text]);
    expect(child.signal).toBe("SIGKILL");
    const key = keyOf(req);
    expect(await files()).toEqual([`${key}.wav`]); // published, nothing else

    const resumed = await make().render(req, { jobId: "job-retry" });
    expect(resumed).toMatchObject({ cached: true, key });
    expect(provider.calls).toBe(0); // no second render for work already done
  });

  it("killed in the middle of writing: a partial temp file is ignored, and nothing is served from it", async () => {
    const key = keyOf(req);
    const whole = await make().render(req).then((r) => readFile(r.path));
    await rm(join(dir, `${key}.wav`));
    await writeFile(join(dir, tempName(key, "job-crash")), whole.subarray(0, 100)); // as if killed partway through writeFile

    const cache = make();
    expect(await cache.lookup(req)).toBeUndefined();
    expect((await cache.render(req)).cached).toBe(false);
    expect(validateWav(await readFile(join(dir, `${key}.wav`))).frames).toBeGreaterThan(0);
    await utimes(join(dir, tempName(key, "job-crash")), OLD_DATE(), OLD_DATE());
    expect(await cache.sweepAbandoned()).toEqual([tempName(key, "job-crash")]);
  });

  it("several processes rendering the same line at once all end with one valid file and no temp files", async () => {
    const children = await Promise.all(Array.from({ length: 4 }, () => runChild("crash-child.ts", [dir, "complete", text])));
    expect(children.map((c) => c.code)).toEqual([0, 0, 0, 0]);
    const reports = children.map((c) => JSON.parse(c.stdout) as { key: string; frames: number });
    expect(new Set(reports.map((r) => r.key)).size).toBe(1);
    const key = keyOf(req);
    expect(await files()).toEqual([`${key}.wav`]);
    expect(validateWav(await readFile(join(dir, `${key}.wav`))).frames).toBe(reports[0]!.frames);
    expect((await stat(join(dir, `${key}.wav`))).isFile()).toBe(true);
  }, 90_000);
});

const OLD_DATE = () => new Date(Date.now() - 3_600_000);
