import type { DatabaseSync } from "node:sqlite";
import type { BudgetLedger } from "@midnight-radio/db";
import type { JobQueue } from "./jobs/queue.js";
import type { JobHandler } from "./jobs/runner.js";

export interface HandlerDeps {
  db: DatabaseSync;
  queue: JobQueue;
  /** Every paid LLM/TTS call must go through `ledger.withReservation`, with `ctx.assertLease` as the fence. */
  ledger: BudgetLedger;
}

/**
 * Job kinds this worker can run. Empty until the pipeline stages exist: ingest (task 3), cast
 * (task 4), adapt and validate (tasks 6–7), render (task 8) and mix (task 9) register here.
 * Jobs of unregistered kinds stay queued.
 */
export function createHandlers(_deps: HandlerDeps): Record<string, JobHandler> {
  return {};
}
