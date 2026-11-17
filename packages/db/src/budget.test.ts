import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetLedger, loadBudgetConfig, type BudgetConfig } from "./budget.js";
import { BudgetExceededError, OverBudgetError } from "./errors.js";
import { openDb } from "./open.js";

const DAY1 = Date.UTC(2026, 10, 15, 12);
const DAY2 = Date.UTC(2026, 10, 16, 0, 0, 1);
const CFG: BudgetConfig = { dailyTtsChars: 10_000, dailyLlmTokens: 5_000, bookTtsCharCeiling: 6_000 };

let db: DatabaseSync;
let clock: number;
let n: number;

const addBook = (d: DatabaseSync, id = "b1", charBudget = 60_000) =>
  d.prepare("INSERT INTO books (id, title, source_hash, char_budget, status, created_at) VALUES (?, 'T', 'h', ?, 'ready', 0)").run(id, charBudget);
const ledger = (cfg: BudgetConfig = CFG, d = db) => new BudgetLedger(d, cfg, { now: () => clock, newId: () => `r${++n}` });
const limitOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof BudgetExceededError) return e.limit;
    throw e;
  }
  return "ok";
};

beforeEach(() => {
  db = openDb(":memory:");
  clock = DAY1;
  n = 0;
  addBook(db);
});
afterEach(() => db.close());

describe("loadBudgetConfig", () => {
  it("fails closed when caps are missing or zero", () => {
    expect(loadBudgetConfig({})).toEqual({ dailyTtsChars: 0, dailyLlmTokens: 0, bookTtsCharCeiling: 60_000 });
    expect(loadBudgetConfig({ GLOBAL_DAILY_TTS_CHAR_LIMIT: "0", GLOBAL_DAILY_LLM_TOKEN_LIMIT: " " }).dailyTtsChars).toBe(0);
  });

  it("parses valid values and rejects malformed ones", () => {
    expect(loadBudgetConfig({ GLOBAL_DAILY_TTS_CHAR_LIMIT: "200000", GLOBAL_DAILY_LLM_TOKEN_LIMIT: "1000000", BOOK_TTS_CHAR_LIMIT: "30000" })).toEqual({
      dailyTtsChars: 200_000,
      dailyLlmTokens: 1_000_000,
      bookTtsCharCeiling: 30_000,
    });
    for (const bad of ["-1", "1.5", "1e6", "abc", "99999999999999999999"]) {
      expect(() => loadBudgetConfig({ GLOBAL_DAILY_TTS_CHAR_LIMIT: bad })).toThrow(/GLOBAL_DAILY_TTS_CHAR_LIMIT/);
    }
  });
});

describe("reserve", () => {
  it("disables each kind of paid call when its cap is zero", () => {
    const l = ledger({ ...CFG, dailyTtsChars: 0, dailyLlmTokens: 0 });
    expect(limitOf(() => l.reserve({ bookId: "b1", ttsChars: 1 }))).toBe("tts_disabled");
    expect(limitOf(() => l.reserve({ bookId: "b1", llmInputTokens: 1 }))).toBe("llm_disabled");
    const ttsOnly = ledger({ ...CFG, dailyLlmTokens: 0 });
    expect(limitOf(() => ttsOnly.reserve({ bookId: "b1", ttsChars: 1 }))).toBe("ok");
  });

  it("budget errors are OverBudgetErrors so the runner parks the job", () => {
    const l = ledger({ ...CFG, dailyTtsChars: 0 });
    expect(() => l.reserve({ bookId: "b1", ttsChars: 1 })).toThrow(OverBudgetError);
  });

  it("enforces the daily TTS cap across books", () => {
    addBook(db, "b2");
    const l = ledger({ ...CFG, bookTtsCharCeiling: 100_000 });
    l.reserve({ bookId: "b1", ttsChars: 6_000 });
    expect(limitOf(() => l.reserve({ bookId: "b2", ttsChars: 4_001 }))).toBe("daily_tts");
    expect(limitOf(() => l.reserve({ bookId: "b2", ttsChars: 4_000 }))).toBe("ok");
  });

  it("counts LLM input plus max output against the daily LLM cap", () => {
    const l = ledger();
    l.reserve({ bookId: "b1", llmInputTokens: 3_000, llmMaxOutputTokens: 1_500 });
    expect(limitOf(() => l.reserve({ bookId: "b1", llmInputTokens: 400, llmMaxOutputTokens: 101 }))).toBe("daily_llm");
    expect(limitOf(() => l.reserve({ bookId: "b1", llmInputTokens: 400, llmMaxOutputTokens: 100 }))).toBe("ok");
  });

  it("a user-chosen book budget cannot raise the operator ceiling but can lower it", () => {
    addBook(db, "big", 1_000_000);
    addBook(db, "small", 1_000);
    const l = ledger();
    expect(limitOf(() => l.reserve({ bookId: "big", ttsChars: 6_001 }))).toBe("book_tts");
    expect(limitOf(() => l.reserve({ bookId: "big", ttsChars: 6_000 }))).toBe("ok");
    expect(limitOf(() => l.reserve({ bookId: "small", ttsChars: 1_001 }))).toBe("book_tts");
  });

  it("resets daily caps at UTC midnight but not the book budget", () => {
    const l = ledger({ ...CFG, dailyTtsChars: 5_000 });
    l.reserve({ bookId: "b1", ttsChars: 5_000 });
    expect(limitOf(() => l.reserve({ bookId: "b1", ttsChars: 1 }))).toBe("daily_tts");
    clock = DAY2;
    expect(limitOf(() => l.reserve({ bookId: "b1", ttsChars: 1_001 }))).toBe("book_tts");
    expect(limitOf(() => l.reserve({ bookId: "b1", ttsChars: 1_000 }))).toBe("ok");
  });

  it("rejects invalid amounts and unknown books without writing", () => {
    const l = ledger();
    expect(() => l.reserve({ bookId: "b1" })).toThrow(/must request/);
    expect(() => l.reserve({ bookId: "b1", ttsChars: -1 })).toThrow(/non-negative/);
    expect(() => l.reserve({ bookId: "b1", ttsChars: 1.5 })).toThrow(/non-negative/);
    expect(() => l.reserve({ bookId: "nope", ttsChars: 1 })).toThrow(/unknown book/);
    expect(db.prepare("SELECT COUNT(*) c FROM budget_reservations").get()).toEqual({ c: 0 });
  });

  it("a failing fence (lost job lease) prevents the reservation", () => {
    const l = ledger();
    expect(() =>
      l.reserve({ bookId: "b1", ttsChars: 10 }, {
        fence: () => {
          throw new Error("lease lost");
        },
      }),
    ).toThrow("lease lost");
    expect(l.daySpend().ttsChars).toBe(0);
  });

  it("two connections cannot overshoot the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-budget-"));
    try {
      const path = join(dir, "b.db");
      const a = openDb(path);
      addBook(a);
      const b = openDb(path);
      const la = ledger(CFG, a);
      const lb = ledger(CFG, b);
      const results = [la, lb, la, lb].map((l) => limitOf(() => l.reserve({ bookId: "b1", ttsChars: 2_500 })));
      expect(results).toEqual(["ok", "ok", "book_tts", "book_tts"]);
      expect(la.bookSpend("b1").ttsChars).toBe(5_000);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settlement", () => {
  it("settle replaces the reservation with actual usage and records usage", () => {
    const l = ledger();
    const id = l.reserve({ bookId: "b1", chapterId: null, llmInputTokens: 1_000, llmMaxOutputTokens: 2_000 });
    expect(l.daySpend().llmTokens).toBe(3_000);
    l.settle(id, { llmInputTokens: 1_000, llmOutputTokens: 700, providerRequestId: "req_1", wallMs: 1234 });
    expect(l.daySpend().llmTokens).toBe(1_700);
    expect(db.prepare("SELECT provider_request_id p, state FROM budget_reservations").get()).toEqual({ p: "req_1", state: "settled" });
    expect(db.prepare("SELECT day_utc, book_id, chapter_id, llm_in, llm_out, tts_chars, wall_ms FROM usage").get()).toEqual({
      day_utc: "2026-11-15",
      book_id: "b1",
      chapter_id: null,
      llm_in: 1_000,
      llm_out: 700,
      tts_chars: 0,
      wall_ms: 1234,
    });
    expect(() => l.settle(id, {})).toThrow(/already settled/);
  });

  it("release frees the reservation; uncertain keeps it and cannot be released", () => {
    const l = ledger();
    const a = l.reserve({ bookId: "b1", ttsChars: 1_000 });
    const b = l.reserve({ bookId: "b1", ttsChars: 2_000 });
    l.release(a);
    l.markUncertain(b);
    expect(l.daySpend().ttsChars).toBe(2_000);
    expect(() => l.release(b)).toThrow(/not reserved/);
    l.settle(b, { ttsChars: 2_000 }); // a late confirmation may still settle it
    expect(l.daySpend().ttsChars).toBe(2_000);
  });

  it("withReservation settles on success, releases provably unbilled errors and keeps others uncertain", async () => {
    const l = ledger();
    const ok = await l.withReservation({ bookId: "b1", ttsChars: 100 }, async () => {
      clock += 50;
      return { value: "wav", usage: { ttsChars: 90 } };
    });
    expect(ok).toBe("wav");
    await expect(
      l.withReservation({ bookId: "b1", ttsChars: 200 }, async () => {
        throw Object.assign(new Error("400 bad voice"), { billed: false });
      }),
    ).rejects.toThrow("400 bad voice");
    await expect(
      l.withReservation({ bookId: "b1", ttsChars: 300 }, async () => {
        throw new Error("socket hang up");
      }),
    ).rejects.toThrow("socket hang up");
    const states = db.prepare("SELECT tts_chars, state FROM budget_reservations ORDER BY rowid").all();
    expect(states).toEqual([
      { tts_chars: 100, state: "settled" },
      { tts_chars: 200, state: "released" },
      { tts_chars: 300, state: "uncertain" },
    ]);
    expect(l.daySpend().ttsChars).toBe(390);
    expect(db.prepare("SELECT wall_ms FROM usage").get()).toEqual({ wall_ms: 50 });
  });

  it("withReservation never calls the provider when over budget", async () => {
    const l = ledger({ ...CFG, dailyTtsChars: 0 });
    let called = false;
    await expect(
      l.withReservation({ bookId: "b1", ttsChars: 1 }, async () => {
        called = true;
        return { value: null, usage: {} };
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(called).toBe(false);
  });
});

describe("property: caps are never exceeded", () => {
  type Op =
    | { t: "reserve"; book: number; tts: number; llmIn: number; llmOut: number }
    | { t: "settle"; i: number; frac: number }
    | { t: "release"; i: number }
    | { t: "uncertain"; i: number }
    | { t: "nextDay" };

  const op: fc.Arbitrary<Op> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ t: fc.constant("reserve" as const), book: fc.integer({ min: 0, max: 2 }), tts: fc.integer({ min: 0, max: 4_000 }), llmIn: fc.integer({ min: 0, max: 2_000 }), llmOut: fc.integer({ min: 0, max: 2_000 }) }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant("settle" as const), i: fc.nat(), frac: fc.double({ min: 0, max: 1, noNaN: true }) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("release" as const), i: fc.nat() }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("uncertain" as const), i: fc.nat() }) },
    { weight: 1, arbitrary: fc.constant({ t: "nextDay" as const }) },
  );

  it("daily and per-book spend stay within limits when actual usage never exceeds the reservation", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const d = openDb(":memory:");
        try {
          const books = ["b0", "b1", "b2"];
          const budgets = [3_000, 60_000, 9_000];
          books.forEach((b, i) => addBook(d, b, budgets[i]));
          clock = DAY1;
          const l = ledger(CFG, d);
          const ids: { id: string; tts: number; llm: number }[] = [];
          const days = new Set<string>();

          for (const o of ops) {
            try {
              if (o.t === "nextDay") clock += 86_400_000;
              else if (o.t === "reserve") {
                if (o.tts + o.llmIn + o.llmOut === 0) continue;
                const id = l.reserve({ bookId: books[o.book]!, ttsChars: o.tts, llmInputTokens: o.llmIn, llmMaxOutputTokens: o.llmOut });
                ids.push({ id, tts: o.tts, llm: o.llmIn + o.llmOut });
                days.add(new Date(clock).toISOString().slice(0, 10));
              } else if (ids.length > 0) {
                const r = ids[o.i % ids.length]!;
                if (o.t === "settle") {
                  const llm = Math.floor(r.llm * o.frac);
                  l.settle(r.id, { ttsChars: Math.floor(r.tts * o.frac), llmInputTokens: Math.min(llm, 1), llmOutputTokens: llm - Math.min(llm, 1) });
                } else if (o.t === "release") l.release(r.id);
                else l.markUncertain(r.id);
              }
            } catch (e) {
              if (!(e instanceof BudgetExceededError) && !/already|is not/.test((e as Error).message)) throw e;
            }
          }
          for (const day of days) {
            const s = l.daySpend(day);
            if (s.ttsChars > CFG.dailyTtsChars || s.llmTokens > CFG.dailyLlmTokens) return false;
          }
          return books.every((b, i) => l.bookSpend(b).ttsChars <= Math.min(budgets[i]!, CFG.bookTtsCharCeiling));
        } finally {
          d.close();
        }
      }),
      { numRuns: 200 },
    );
  });
});
