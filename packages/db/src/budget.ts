import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BudgetExceededError } from "./errors.js";

export interface BudgetConfig {
  /** Global TTS characters per UTC day. 0 disables paid TTS. */
  dailyTtsChars: number;
  /** Global LLM tokens (input + capped output) per UTC day. 0 disables paid LLM calls. */
  dailyLlmTokens: number;
  /** Operator ceiling on any Book's TTS budget; a user-chosen `books.char_budget` cannot exceed it. */
  bookTtsCharCeiling: number;
}

export const DEFAULT_BOOK_TTS_CHAR_CEILING = 60_000;

/**
 * Read caps from the environment. Missing or "0" disables that kind of paid call (fail closed).
 * A malformed value throws so a misconfigured deployment fails loudly at startup.
 */
export function loadBudgetConfig(env: Record<string, string | undefined> = process.env): BudgetConfig {
  const read = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new Error(`${name} is too large`);
    return n;
  };
  return {
    dailyTtsChars: read("GLOBAL_DAILY_TTS_CHAR_LIMIT", 0),
    dailyLlmTokens: read("GLOBAL_DAILY_LLM_TOKEN_LIMIT", 0),
    bookTtsCharCeiling: read("BOOK_TTS_CHAR_LIMIT", DEFAULT_BOOK_TTS_CHAR_CEILING),
  };
}

export interface ReservationRequest {
  bookId: string;
  /** Null for book-wide work such as casting. */
  chapterId?: string | null;
  jobId?: string | null;
  ttsChars?: number;
  llmInputTokens?: number;
  /** The `max_tokens` sent to the provider, so the reservation bounds the worst case. */
  llmMaxOutputTokens?: number;
}

export interface ActualUsage {
  ttsChars?: number;
  llmInputTokens?: number;
  llmOutputTokens?: number;
  providerRequestId?: string;
  wallMs?: number;
}

export interface Spend {
  ttsChars: number;
  llmTokens: number;
}

export interface PaidCallResult<T> {
  value: T;
  usage: Omit<ActualUsage, "wallMs">;
}

/** Errors with `billed === false` prove the provider did not charge; the reservation is released. */
export const isNotBilled = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { billed?: unknown }).billed === false;

export interface LedgerOptions {
  now?: () => number;
  newId?: () => string;
}

export const dayUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const nonNegInt = (n: number | undefined, name: string): number => {
  const v = n ?? 0;
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer`);
  return v;
};

// Counted spend: settled → actual, released → nothing, reserved/uncertain → full reservation.
const COUNTED_TTS = "CASE state WHEN 'settled' THEN actual_tts_chars WHEN 'released' THEN 0 ELSE tts_chars END";
const COUNTED_LLM = "CASE state WHEN 'settled' THEN actual_llm_tokens WHEN 'released' THEN 0 ELSE llm_tokens END";

/**
 * Durable spend ledger. Every paid LLM/TTS call reserves its worst case first, inside a write
 * transaction, so concurrent workers cannot overshoot caps. Outcomes:
 * - `settle`: provider responded; actual usage replaces the reservation and a `usage` row is written.
 * - `release`: provider provably did not bill (e.g. request rejected before processing).
 * - `markUncertain`: outcome unknown (timeout, dropped connection); the full reservation stays counted.
 * Reservations left `reserved` by a crashed worker also stay counted.
 */
export class BudgetLedger {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly db: DatabaseSync,
    private readonly config: BudgetConfig,
    opts: LedgerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
  }

  /**
   * Reserve budget or throw BudgetExceededError. `fence` runs first inside the same transaction;
   * pass a job-lease check so a stale worker cannot reserve (and then spend).
   */
  reserve(req: ReservationRequest, opts: { fence?: () => void } = {}): string {
    const tts = nonNegInt(req.ttsChars, "ttsChars");
    const llm = nonNegInt(req.llmInputTokens, "llmInputTokens") + nonNegInt(req.llmMaxOutputTokens, "llmMaxOutputTokens");
    if (tts === 0 && llm === 0) throw new Error("reservation must request TTS characters or LLM tokens");

    return this.tx(() => {
      opts.fence?.();
      const t = this.now();
      const day = dayUtc(t);
      const { dailyTtsChars, dailyLlmTokens } = this.config;

      if (tts > 0) {
        if (dailyTtsChars <= 0) throw new BudgetExceededError("tts_disabled", "Paid voice rendering is disabled on this server.");
        const book = this.db.prepare("SELECT char_budget FROM books WHERE id = ?").get(req.bookId) as { char_budget: number } | undefined;
        if (!book) throw new Error(`unknown book ${req.bookId}`);
        const bookLimit = Math.min(Number(book.char_budget), this.config.bookTtsCharCeiling);
        if (this.daySpend(day).ttsChars + tts > dailyTtsChars) {
          throw new BudgetExceededError("daily_tts", "Today's voice rendering allowance is used up. Try again after midnight UTC.");
        }
        if (this.bookSpend(req.bookId).ttsChars + tts > bookLimit) {
          throw new BudgetExceededError("book_tts", `This book has reached its ${bookLimit.toLocaleString("en")}-character voice budget.`);
        }
      }
      if (llm > 0) {
        if (dailyLlmTokens <= 0) throw new BudgetExceededError("llm_disabled", "Paid script adaptation is disabled on this server.");
        if (this.daySpend(day).llmTokens + llm > dailyLlmTokens) {
          throw new BudgetExceededError("daily_llm", "Today's script adaptation allowance is used up. Try again after midnight UTC.");
        }
      }

      const id = this.newId();
      this.db
        .prepare(
          `INSERT INTO budget_reservations (id, job_id, day_utc, book_id, chapter_id, llm_tokens, tts_chars, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(id, req.jobId ?? null, day, req.bookId, req.chapterId ?? null, llm, tts, t, t);
      return id;
    });
  }

  /** Record actual usage. Not fenced: money already spent is recorded even by a stale worker. */
  settle(id: string, usage: ActualUsage): void {
    const tts = nonNegInt(usage.ttsChars, "ttsChars");
    const llmIn = nonNegInt(usage.llmInputTokens, "llmInputTokens");
    const llmOut = nonNegInt(usage.llmOutputTokens, "llmOutputTokens");
    const wall = nonNegInt(usage.wallMs, "wallMs");
    this.tx(() => {
      const r = this.db
        .prepare("SELECT day_utc, book_id, chapter_id, state FROM budget_reservations WHERE id = ?")
        .get(id) as { day_utc: string; book_id: string | null; chapter_id: string | null; state: string } | undefined;
      if (!r) throw new Error(`unknown reservation ${id}`);
      if (r.state !== "reserved" && r.state !== "uncertain") throw new Error(`reservation ${id} is already ${r.state}`);
      const t = this.now();
      this.db
        .prepare(
          `UPDATE budget_reservations SET state = 'settled', actual_tts_chars = ?, actual_llm_tokens = ?,
             provider_request_id = COALESCE(?, provider_request_id), updated_at = ? WHERE id = ?`,
        )
        .run(tts, llmIn + llmOut, usage.providerRequestId ?? null, t, id);
      this.db
        .prepare(
          "INSERT INTO usage (id, day_utc, book_id, chapter_id, llm_in, llm_out, tts_chars, wall_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(this.newId(), r.day_utc, r.book_id, r.chapter_id, llmIn, llmOut, tts, wall);
    });
  }

  /** Only for calls the provider provably did not bill. */
  release(id: string): void {
    this.transition(id, "reserved", "released");
  }

  markUncertain(id: string): void {
    this.transition(id, "reserved", "uncertain");
  }

  /**
   * Reserve, run the paid call, then settle. On error: release if the error proves no charge
   * (`billed === false`), otherwise keep the reservation as uncertain. Always rethrows.
   */
  async withReservation<T>(
    req: ReservationRequest,
    call: () => Promise<PaidCallResult<T>>,
    opts: { fence?: () => void } = {},
  ): Promise<T> {
    const id = this.reserve(req, opts);
    const started = this.now();
    let result: PaidCallResult<T>;
    try {
      result = await call();
    } catch (err) {
      if (isNotBilled(err)) this.release(id);
      else this.markUncertain(id);
      throw err;
    }
    this.settle(id, { ...result.usage, wallMs: Math.max(0, this.now() - started) });
    return result.value;
  }

  daySpend(day = dayUtc(this.now())): Spend {
    return this.spend("day_utc = ?", day);
  }

  bookSpend(bookId: string): Spend {
    return this.spend("book_id = ?", bookId);
  }

  private spend(where: string, arg: string): Spend {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(${COUNTED_TTS}), 0) AS tts, COALESCE(SUM(${COUNTED_LLM}), 0) AS llm FROM budget_reservations WHERE ${where}`)
      .get(arg) as { tts: number; llm: number };
    return { ttsChars: Number(row.tts), llmTokens: Number(row.llm) };
  }

  private transition(id: string, from: string, to: string): void {
    const res = this.db
      .prepare("UPDATE budget_reservations SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
      .run(to, this.now(), id, from);
    if (Number(res.changes) !== 1) throw new Error(`reservation ${id} is not ${from}`);
  }

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
