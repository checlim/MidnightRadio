import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

const BUSY_TIMEOUT_MS = 5000;

/**
 * Open the SQLite database (e.g. `/data/midnight-radio.db`, or `:memory:` in tests),
 * apply connection pragmas and run pending migrations.
 * Safe to call from several processes at once on the same file (web + worker at boot).
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    if (path !== ":memory:") {
      // Switching journal mode does not always wait on the busy handler, so retry it ourselves.
      retryWhileLocked(() => db.exec("PRAGMA journal_mode = WAL;"), BUSY_TIMEOUT_MS);
      db.exec("PRAGMA synchronous = NORMAL;");
    }
    migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

const isLocked = (err: unknown) => /database is locked|SQLITE_BUSY/i.test((err as Error)?.message ?? "");

/** Retry a synchronous SQLite call while the database is locked, with short sleeps, up to `timeoutMs`. */
export function retryWhileLocked<T>(fn: () => T, timeoutMs: number): T {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      return fn();
    } catch (err) {
      if (!isLocked(err) || Date.now() >= deadline) throw err;
      sleepSync(delay);
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
