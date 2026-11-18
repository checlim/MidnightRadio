// Worker process entrypoint. Run with `pnpm -C apps/worker start`.
// Exit codes: 0 after a clean shutdown; 1 on bad config, a crash or a shutdown timeout, so the
// container supervisor restarts the service. A job interrupted by a forced exit is reclaimed
// after its lease expires.
import { errorFields, jsonLogger } from "./log.js";
import { startWorker, type RunningWorker } from "./worker.js";

const log = jsonLogger();
let worker: RunningWorker | undefined;
let stopping = false;

// Install handlers before anything else: until they exist, SIGTERM uses Node's default action
// (immediate kill), and a supervisor may signal as soon as it sees the first log line.
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", errorFields(err));
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log.error("unhandled rejection", errorFields(err));
  process.exit(1);
});

try {
  worker = startWorker({ log });
} catch (err) {
  log.error("worker failed to start", errorFields(err));
  process.exit(1);
}

// The loop only ends after stop(); if it ever ends on its own, exit so the supervisor restarts us.
void worker.done.then(() => {
  if (!stopping) {
    log.error("worker loop ended unexpectedly");
    process.exit(1);
  }
});

function shutdown(signal: NodeJS.Signals): void {
  if (stopping) {
    log.warn("second signal; exiting without waiting", { signal });
    process.exit(1);
  }
  stopping = true;
  log.info("shutdown requested", { signal });
  if (!worker) process.exit(0); // startup is synchronous, so this only happens if it never began
  setTimeout(() => {
    log.error("shutdown timed out; exiting", { timeoutMs: worker!.config.shutdownTimeoutMs });
    process.exit(1);
  }, worker.config.shutdownTimeoutMs).unref();
  worker.stop().then(
    () => process.exit(0),
    (err) => {
      log.error("shutdown failed", errorFields(err));
      process.exit(1);
    },
  );
}
