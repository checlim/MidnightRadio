import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Server-side guard for every generation-triggering route (upload, adapt, render, cast edit, retry).
 * Demo playback routes must not use it.
 *
 * The passkey is read from a request header (never a URL/query parameter) and is never logged.
 * State is in memory: correct for the single-container, single-replica deployment; it resets on restart.
 */

export interface WindowLimit {
  max: number;
  windowMs: number;
}

export interface GuardConfig {
  /** Optional judge passkey (`UPLOAD_PASSKEY`). Unset or blank disables the gate. */
  passkey?: string | undefined;
  /** Every generation attempt per client, successful or not. */
  requests: WindowLimit;
  /** Wrong-passkey attempts per client; exceeding it locks the client out for the window. */
  passkeyFailures: WindowLimit;
}

export const DEFAULT_GUARD_LIMITS = {
  requests: { max: 10, windowMs: 10 * 60_000 },
  passkeyFailures: { max: 5, windowMs: 15 * 60_000 },
} as const;

export const PASSKEY_HEADER = "x-midnight-passkey";

export function loadGuardConfig(env: Record<string, string | undefined> = process.env): GuardConfig {
  const passkey = env.UPLOAD_PASSKEY?.trim();
  return { passkey: passkey ? passkey : undefined, ...DEFAULT_GUARD_LIMITS };
}

export type GuardResult =
  | { ok: true }
  | { ok: false; status: 401 | 429; message: string; retryAfterSec?: number };

/** Fixed-window counter per key, with a bounded number of tracked keys. */
export class WindowCounter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: WindowLimit,
    private readonly maxKeys = 10_000,
  ) {}

  /** Seconds until the window resets if `key` is at its limit, otherwise 0. */
  blockedFor(key: string, now: number): number {
    const h = this.current(key, now);
    return h && h.count >= this.limit.max ? Math.ceil((h.start + this.limit.windowMs - now) / 1000) : 0;
  }

  hit(key: string, now: number): void {
    const h = this.current(key, now);
    if (h) {
      h.count++;
      return;
    }
    if (this.hits.size >= this.maxKeys) this.evict(now);
    this.hits.set(key, { start: now, count: 1 });
  }

  private current(key: string, now: number) {
    const h = this.hits.get(key);
    if (h && now - h.start >= this.limit.windowMs) {
      this.hits.delete(key);
      return undefined;
    }
    return h;
  }

  private evict(now: number): void {
    for (const [k, h] of this.hits) if (now - h.start >= this.limit.windowMs) this.hits.delete(k);
    // Still full: drop the oldest entry (Map preserves insertion order).
    if (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
  }
}

/** Constant-time comparison that does not leak length. */
export function passkeyMatches(provided: string | null | undefined, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(provided ?? ""), digest(expected));
}

export class GenerationGuard {
  private readonly requests: WindowCounter;
  private readonly failures: WindowCounter;

  constructor(
    private readonly config: GuardConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.requests = new WindowCounter(config.requests);
    this.failures = new WindowCounter(config.passkeyFailures);
  }

  /**
   * @param clientKey stable client identifier (e.g. the proxy-verified client IP)
   * @param providedPasskey value of the `x-midnight-passkey` header, if any
   */
  check(clientKey: string, providedPasskey: string | null | undefined): GuardResult {
    const t = this.now();
    const locked = this.failures.blockedFor(clientKey, t);
    if (locked > 0) return tooMany(locked, "Too many incorrect passkey attempts. Try again later.");
    const limited = this.requests.blockedFor(clientKey, t);
    if (limited > 0) return tooMany(limited, "Too many generation requests. Try again later.");
    this.requests.hit(clientKey, t); // counted before the passkey check, so failures count too

    if (this.config.passkey && !passkeyMatches(providedPasskey, this.config.passkey)) {
      this.failures.hit(clientKey, t);
      return { ok: false, status: 401, message: "A valid judge passkey is required to generate new episodes." };
    }
    return { ok: true };
  }
}

const tooMany = (retryAfterSec: number, message: string): GuardResult => ({ ok: false, status: 429, message, retryAfterSec });
