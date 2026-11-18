// Child process for the concurrent first-boot test: open (and migrate) the DB, report the outcome.
import { openDb } from "../open.js";

try {
  openDb(process.argv[2]!).close();
  console.log("ok");
} catch (e) {
  console.log(`ERR ${(e as Error).message}`);
}
