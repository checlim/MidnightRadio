import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

/**
 * Open the SQLite database (e.g. `/data/midnight-radio.db`, or `:memory:` in tests),
 * apply connection pragmas and run pending migrations.
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  migrate(db);
  return db;
}
