import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

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

const GuardEnvSchema = z.object({
  // Unset or blank disables the gate. The value is never included in error messages.
  UPLOAD_PASSKEY: z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined)
    .refine((s) => s === undefined || s.length <= 512, "must be at most 512 characters"),
});

export function loadGuardConfig(env: Record<string, string | undefined> = process.env): GuardConfig {
  const parsed = GuardEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid guard configuration: ${parsed.error.issues.map((i) => `${String(i.path[0])} ${i.message}`).join("; ")}`);
  }
  return { passkey: parsed.data.UPLOAD_PASSKEY, ...DEFAULT_GUARD_LIMITS };
}

export type GuardResult =
  | { ok: true }
  | { ok: false; status: 401 | 429; message: string; retryAfterSec?: number };

/**
 * Fixed-window counter per key, with a bounded number of tracked keys.
 *
 * Live entries are never evicted, so a client cannot clear its own lockout by flooding the table
 * with other keys. When the table is full of live entries, untracked keys are refused until the
 * oldest window expires (fail closed under a key-rotation flood).
 */
export class WindowCounter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: WindowLimit,
    private readonly maxKeys = 10_000,
  ) {}

  /** Seconds until `key` may proceed: its own window if at the limit, or the table's if full. 0 if allowed. */
  blockedFor(key: string, now: number): number {
    const h = this.current(key, now);
    if (h) return h.count >= this.limit.max ? this.secondsLeft(h.start, now) : 0;
    if (this.hits.size >= this.maxKeys) this.purgeExpired(now);
    if (this.hits.size < this.maxKeys) return 0;
    const oldest = this.hits.values().next().value!; // Map keeps insertion order
    return this.secondsLeft(oldest.start, now);
  }

  /** Record a hit. Returns false (and records nothing) if the key is untracked and the table is full. */
  hit(key: string, now: number): boolean {
    const h = this.current(key, now);
    if (h) {
      h.count++;
      return true;
    }
    if (this.hits.size >= this.maxKeys) this.purgeExpired(now);
    if (this.hits.size >= this.maxKeys) return false;
    this.hits.set(key, { start: now, count: 1 });
    return true;
  }

  private secondsLeft(start: number, now: number): number {
    return Math.max(1, Math.ceil((start + this.limit.windowMs - now) / 1000));
  }

  private current(key: string, now: number) {
    const h = this.hits.get(key);
    if (h && now - h.start >= this.limit.windowMs) {
      this.hits.delete(key);
      return undefined;
    }
    return h;
  }

  private purgeExpired(now: number): void {
    for (const [k, h] of this.hits) if (now - h.start >= this.limit.windowMs) this.hits.delete(k);
  }
}

/**
 * Normalise a client IP into a rate-limit key. IPv6 addresses are grouped by /64, because a single
 * client usually controls a whole /64 and could otherwise rotate through unlimited fresh keys.
 * The IP itself must come from the hosting platform's trusted header, never a raw X-Forwarded-For.
 */
export function clientKeyFromIp(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return `v4:${mapped[1]}`;
  if (!addr.includes(":")) return `v4:${addr}`;
  const [head = "", tail = ""] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = addr.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  const prefix = groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, ""));
  return `v6:${prefix.join(":")}::/64`;
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
    // Counted before the passkey check, so failed attempts count too.
    if (!this.requests.hit(clientKey, t)) return tooMany(1, "Too many generation requests. Try again later.");

    if (this.config.passkey && !passkeyMatches(providedPasskey, this.config.passkey)) {
      // If the failure table is full, the attempt cannot be tracked; refuse rather than allow untracked guessing.
      if (!this.failures.hit(clientKey, t)) return tooMany(1, "Too many incorrect passkey attempts. Try again later.");
      return { ok: false, status: 401, message: "A valid judge passkey is required to generate new episodes." };
    }
    return { ok: true };
  }
}

const tooMany = (retryAfterSec: number, message: string): GuardResult => ({ ok: false, status: 429, message, retryAfterSec });
