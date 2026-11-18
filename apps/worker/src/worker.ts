import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BudgetLedger, loadBudgetConfig, openDb } from "@midnight-radio/db";
import { DB_FILE, loadWorkerConfig, type WorkerConfig } from "./config.js";
import { createHandlers, type HandlerDeps } from "./handlers.js";
import { JobQueue, type JobQueueOptions } from "./jobs/queue.js";
import { runWorker, type JobHandler } from "./jobs/runner.js";
import { errorFields, jsonLogger, type Logger } from "./log.js";

export interface WorkerOptions {
  env?: Record<string, string | undefined>;
  log?: Logger;
  /** Override the handler registry (tests). */
  createHandlers?: (deps: HandlerDeps) => Record<string, JobHandler>;
  queueOptions?: JobQueueOptions;
  pollMs?: number;
}

export interface RunningWorker {
  config: WorkerConfig;
  queue: JobQueue;
  db: DatabaseSync;
  /** Settles once the loop has exited and the database is closed. */
  done: Promise<void>;
  /** Stop claiming, release the current job (without using an attempt), close the DB. */
  stop(): Promise<void>;
}

/**
 * Validate configuration, open the database on the data volume (migrating it), and start the
 * job loop. Throws on bad configuration or an unusable database, so the process fails at boot.
 */
export function startWorker(opts: WorkerOptions = {}): RunningWorker {
  const env = opts.env ?? process.env;
  const log = opts.log ?? jsonLogger();
  const config = loadWorkerConfig(env);
  const budget = loadBudgetConfig(env); // fail at boot on malformed caps, not at the first paid call

  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, DB_FILE));
  let handlers: Record<string, JobHandler>;
  let queue: JobQueue;
  try {
    queue = new JobQueue(db, opts.queueOptions);
    const ledger = new BudgetLedger(db, budget);
    handlers = (opts.createHandlers ?? createHandlers)({ db, queue, ledger });
  } catch (err) {
    db.close();
    throw err;
  }

  const ctrl = new AbortController();
  log.info("worker started", {
    dataDir: config.dataDir,
    jobKinds: Object.keys(handlers),
    paidTts: budget.dailyTtsChars > 0,
    paidLlm: budget.dailyLlmTokens > 0,
  });
  if (Object.keys(handlers).length === 0) log.warn("no job handlers registered; queued jobs will wait");

  const done = runWorker({
    queue,
    handlers,
    signal: ctrl.signal,
    ...(opts.pollMs === undefined ? {} : { pollMs: opts.pollMs }),
    onError: (err, job) => log.error("job error", { ...errorFields(err), jobId: job?.id, jobKind: job?.kind }),
  }).finally(() => {
    db.close();
    log.info("worker stopped");
  });

  return {
    config,
    queue,
    db,
    done,
    stop: () => {
      ctrl.abort();
      return done;
    },
  };
}
