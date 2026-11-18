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

const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const nonNegInt = (n: number | undefined, name: string): number => {
  const v = n ?? 0;
  if (!isNonNegInt(v)) throw new Error(`${name} must be a non-negative integer`);
  return v;
};

const optNonNegInt = (n: number | undefined, name: string): number | undefined =>
  n === undefined ? undefined : nonNegInt(n, name);

/** Provider-reported usage is untrusted: drop malformed fields so they settle as the reserved amount. */
function sanitiseUsage(u: PaidCallResult<unknown>["usage"] | undefined): Omit<ActualUsage, "wallMs"> {
  const out: Omit<ActualUsage, "wallMs"> = {};
  if (!u || typeof u !== "object") return out;
  if (isNonNegInt(u.ttsChars)) out.ttsChars = u.ttsChars;
  if (isNonNegInt(u.llmInputTokens)) out.llmInputTokens = u.llmInputTokens;
  if (isNonNegInt(u.llmOutputTokens)) out.llmOutputTokens = u.llmOutputTokens;
  if (typeof u.providerRequestId === "string" && u.providerRequestId.length <= 200) out.providerRequestId = u.providerRequestId;
  return out;
}

const SETTLE_ATTEMPTS = 3;

interface ReservationRow {
  day_utc: string;
  book_id: string | null;
  chapter_id: string | null;
  state: string;
  tts_chars: number;
  llm_tokens: number;
}

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

  /**
   * Record actual usage. Not fenced: money already spent is recorded even by a stale worker.
   *
   * Fails closed: a usage field the provider did not report is recorded as the reserved amount
   * (flagged `usage_estimated`), never as zero. Usage above the reservation is recorded as-is and
   * flagged `overrun`; because settled actuals count toward the caps, further reservations are
   * refused until spend is back under them.
   */
  settle(id: string, usage: ActualUsage): void {
    const reportedTts = optNonNegInt(usage.ttsChars, "ttsChars");
    const reportedIn = optNonNegInt(usage.llmInputTokens, "llmInputTokens");
    const reportedOut = optNonNegInt(usage.llmOutputTokens, "llmOutputTokens");
    const wall = nonNegInt(usage.wallMs, "wallMs");
    this.tx(() => {
      const r = this.reservation(id);
      if (r.state !== "reserved" && r.state !== "uncertain") throw new Error(`reservation ${id} is already ${r.state}`);
      let estimated = false;

      let tts = reportedTts ?? 0;
      if (reportedTts === undefined && r.tts_chars > 0) {
        tts = r.tts_chars;
        estimated = true;
      }

      let llmIn = reportedIn ?? 0;
      let llmOut = reportedOut ?? 0;
      if (r.llm_tokens > 0 && (reportedIn === undefined || reportedOut === undefined)) {
        const total = Math.max(r.llm_tokens, llmIn + llmOut);
        if (reportedIn === undefined) llmIn = total - llmOut;
        else llmOut = total - llmIn;
        estimated = true;
      }

      const overrun = tts > r.tts_chars || llmIn + llmOut > r.llm_tokens;
      this.db
        .prepare(
          `UPDATE budget_reservations SET state = 'settled', actual_tts_chars = ?, actual_llm_tokens = ?,
             overrun = ?, usage_estimated = ?, provider_request_id = COALESCE(?, provider_request_id), updated_at = ?
           WHERE id = ?`,
        )
        .run(tts, llmIn + llmOut, overrun ? 1 : 0, estimated ? 1 : 0, usage.providerRequestId ?? null, this.now(), id);
      this.recordUsage(id, r, { llmIn, llmOut, tts, wall });
    });
  }

  /** Only for calls the provider provably did not bill. */
  release(id: string): void {
    this.transition(id, "reserved", "released");
  }

  /**
   * Outcome unknown (timeout, dropped connection). The full reservation stays counted, and a usage
   * row records it as spent so per-chapter totals do not undercount. A later `settle` replaces it.
   */
  markUncertain(id: string, wallMs = 0): void {
    const wall = nonNegInt(wallMs, "wallMs");
    this.tx(() => {
      const r = this.reservation(id);
      this.transition(id, "reserved", "uncertain");
      this.recordUsage(id, r, { llmIn: r.llm_tokens, llmOut: 0, tts: r.tts_chars, wall });
    });
  }

  /**
   * Reserve, run the paid call, then settle. On error: release if the error proves no charge
   * (`billed === false`), otherwise keep the reservation as uncertain, then rethrow.
   *
   * Once the call has succeeded its result is always returned. If recording usage fails, the
   * reservation stays counted (uncertain or reserved) and `onSettleError` is told; the job is
   * not failed, so a retry never pays for the same request twice.
   */
  async withReservation<T>(
    req: ReservationRequest,
    call: () => Promise<PaidCallResult<T>>,
    opts: { fence?: () => void; onSettleError?: (err: unknown) => void } = {},
  ): Promise<T> {
    const id = this.reserve(req, opts);
    const started = this.now();
    const elapsed = () => Math.max(0, this.now() - started);
    let result: PaidCallResult<T>;
    try {
      result = await call();
    } catch (err) {
      try {
        if (isNotBilled(err)) this.release(id);
        else this.markUncertain(id, elapsed());
      } catch {
        // Could not update the ledger: the reservation stays 'reserved', which still counts in full.
      }
      throw err;
    }

    const usage = sanitiseUsage(result.usage);
    let lastErr: unknown;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      try {
        this.settle(id, { ...usage, wallMs: elapsed() });
        return result.value;
      } catch (err) {
        lastErr = err;
      }
    }
    try {
      this.markUncertain(id, elapsed());
    } catch {
      // Still 'reserved': counted in full.
    }
    opts.onSettleError?.(lastErr);
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

  private reservation(id: string): ReservationRow {
    const r = this.db
      .prepare("SELECT day_utc, book_id, chapter_id, state, tts_chars, llm_tokens FROM budget_reservations WHERE id = ?")
      .get(id) as ReservationRow | undefined;
    if (!r) throw new Error(`unknown reservation ${id}`);
    return { ...r, tts_chars: Number(r.tts_chars), llm_tokens: Number(r.llm_tokens) };
  }

  /** One usage row per reservation: inserted on first outcome, replaced on settlement. */
  private recordUsage(id: string, r: ReservationRow, u: { llmIn: number; llmOut: number; tts: number; wall: number }): void {
    this.db
      .prepare(
        `INSERT INTO usage (id, reservation_id, day_utc, book_id, chapter_id, llm_in, llm_out, tts_chars, wall_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(reservation_id) DO UPDATE SET
           llm_in = excluded.llm_in, llm_out = excluded.llm_out, tts_chars = excluded.tts_chars,
           wall_ms = MAX(usage.wall_ms, excluded.wall_ms)`,
      )
      .run(this.newId(), id, r.day_utc, r.book_id, r.chapter_id, u.llmIn, u.llmOut, u.tts, u.wall);
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
