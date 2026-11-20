import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BudgetLedger, loadBudgetConfig, openDb } from "@midnight-radio/db";
import { sweepAbandonedTemps } from "@midnight-radio/tts";
import { DB_FILE, loadWorkerConfig, type WorkerConfig } from "./config.js";
import { createHandlers, type HandlerDeps } from "./handlers.js";
import { JobQueue, type JobQueueOptions } from "./jobs/queue.js";
import { runWorker, type JobHandler } from "./jobs/runner.js";
import { errorFields, jsonLogger, secretsFrom, type Logger } from "./log.js";

export interface WorkerOptions {
  env?: Record<string, string | undefined>;
  log?: Logger;
  /** Where the default JSON logger writes lines (stdout when unset). Ignored if `log` is given. */
  write?: (line: string) => void;
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
  /** Settles when the start-up sweep of abandoned render temp files has finished (it never rejects). */
  swept: Promise<string[]>;
  /** Stop claiming, release the current job (without using an attempt), close the DB. */
  stop(): Promise<void>;
}

/**
 * Validate configuration, open the database on the data volume (migrating it), and start the
 * job loop. Throws on bad configuration or an unusable database, so the process fails at boot.
 */
export function startWorker(opts: WorkerOptions = {}): RunningWorker {
  const env = opts.env ?? process.env;
  const log = opts.log ?? jsonLogger(opts.write, secretsFrom(env));
  const config = loadWorkerConfig(env);
  const budget = loadBudgetConfig(env); // fail at boot on malformed caps, not at the first metered call

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
    ttsEnabled: budget.dailyTtsChars > 0,
    llmEnabled: budget.dailyLlmTokens > 0,
  });
  if (Object.keys(handlers).length === 0) log.warn("no job handlers registered; queued jobs will wait");

  // Temp files left by a render that died (crash, SIGKILL, power loss) are removed once they are
  // old and their job is no longer running here or on another worker. It runs alongside the job
  // loop: a temp file being written now is new, so it is never old enough to be removed.
  const swept = sweepAbandonedTemps(config.renderCacheDir, {
    isJobActive: (jobId) => {
      const state = queue.get(jobId)?.state;
      return state === "running" || state === "queued";
    },
  }).then(
    (removed) => {
      if (removed.length > 0) log.info("removed abandoned render temp files", { count: removed.length });
      return removed;
    },
    (err: unknown) => {
      log.warn("could not sweep the render cache", errorFields(err));
      return [] as string[];
    },
  );
  const done = runWorker({
    queue,
    handlers,
    signal: ctrl.signal,
    ...(opts.pollMs === undefined ? {} : { pollMs: opts.pollMs }),
    onError: (err, job) => log.error("job error", { ...errorFields(err), jobId: job?.id, jobKind: job?.kind }),
  }).finally(async () => {
    await swept; // the sweep reads job states, so it must finish before the database closes
    db.close();
    log.info("worker stopped");
  });

  return {
    config,
    queue,
    db,
    done,
    swept,
    stop: () => {
      ctrl.abort();
      return done;
    },
  };
}
