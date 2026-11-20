import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "@midnight-radio/db";
import { loadWebConfig, type WebConfig } from "./config";
import { DEFAULT_GUARD_LIMITS, GenerationGuard, PASSKEY_HEADER, clientKeyFromIp, loadGuardConfig } from "./guards";

/**
 * The gate in front of every generation route (Req 8.2, 8.5), in this order:
 * 1. generation disabled (the default, and the live site): 404, as if the route did not exist;
 * 2. `GenerationGuard` (Task 2.3): per-client rate limit counted before the passkey, the optional
 *    judge passkey compared in constant time, and a lockout after repeated wrong passkeys.
 * Writes (upload, generate, cast edits) use the guard's limits; status reads, which the upload page
 * polls, get a looser request limit with the same passkey rules. Passkeys are never logged or echoed.
 */

export { PASSKEY_HEADER };

const makeGuards = () => {
  const config = loadGuardConfig();
  return {
    write: new GenerationGuard(config),
    read: new GenerationGuard({ ...config, requests: { max: 240, windowMs: 60_000 }, passkeyFailures: DEFAULT_GUARD_LIMITS.passkeyFailures }),
  };
};
let guards: ReturnType<typeof makeGuards> | null = null;
/** Forget every client's counts and re-read the passkey (tests). */
export const resetGuards = () => {
  guards = null;
};

export function jsonError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store", ...headers } });
}

export interface Gate {
  config: WebConfig;
  db: () => DatabaseSync;
}

let shared: { path: string; db: DatabaseSync } | null = null;
/** One connection per server process, opened (and migrated) on first use. */
export function sharedDb(config: WebConfig): DatabaseSync {
  const path = join(config.dataDir, "midnight-radio.db");
  if (shared?.path !== path) {
    shared?.db.close();
    mkdirSync(config.dataDir, { recursive: true });
    shared = { path, db: openDb(path) };
  }
  return shared.db;
}

/**
 * Run `handler` if the request may use generation, else answer with the refusal. Without a
 * trusted client-IP header every client shares one key, which fails safe. Unexpected errors become
 * a 500 without details.
 */
export async function guarded(request: Request, kind: "read" | "write", handler: (gate: Gate) => Promise<Response>): Promise<Response> {
  const config = loadWebConfig();
  if (!config.generationEnabled) return jsonError(404, "Generation is not available on this site.");
  guards ??= makeGuards();
  const ip = config.clientIpHeader ? request.headers.get(config.clientIpHeader) : null;
  const verdict = guards[kind].check(clientKeyFromIp(ip ?? "unknown"), request.headers.get(PASSKEY_HEADER));
  if (!verdict.ok) return jsonError(verdict.status, verdict.message, verdict.retryAfterSec ? { "retry-after": String(verdict.retryAfterSec) } : {});
  try {
    return await handler({ config, db: () => sharedDb(config) });
  } catch (err) {
    console.error("generation route failed:", err instanceof Error ? err.name : "error");
    return jsonError(500, "Something went wrong on the server.");
  }
}
