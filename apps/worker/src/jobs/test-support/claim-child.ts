// Child process for the concurrent-claim test: claim and complete jobs until none are left,
// then print the claimed job IDs, comma-separated.
import { openDb } from "@midnight-radio/db";
import { JobQueue } from "../queue.js";

const db = openDb(process.argv[2]!);
const queue = new JobQueue(db, { leaseMs: 60_000 });
const claimed: string[] = [];
for (let c = queue.claim(); c; c = queue.claim()) {
  claimed.push(c.job.id);
  queue.complete(c.lease);
}
db.close();
console.log(claimed.join(","));
