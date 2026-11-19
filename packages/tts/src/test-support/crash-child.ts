// Child process for the crash-recovery tests: render one line into a cache directory, and (by mode)
// kill itself with SIGKILL at a chosen point, so no cleanup code gets to run.
//   node --import tsx crash-child.ts <dir> <mode> <text>
// modes: before-rename (temp file written and synced, not yet renamed), after-rename (published,
// but the caller has not recorded it anywhere), complete (no crash).
import { RenderCache } from "../render-cache.js";
import { StubProvider } from "../stub.js";

const [dir, mode, text] = process.argv.slice(2) as [string, string, string];

const die = (): Promise<never> => {
  console.log("KILLING");
  process.kill(process.pid, "SIGKILL");
  return new Promise<never>(() => undefined); // never returns; SIGKILL cannot be caught
};

const cache = new RenderCache({
  dir,
  provider: new StubProvider(),
  hooks: {
    ...(mode === "before-rename" ? { afterTempWritten: die } : {}),
    ...(mode === "after-rename" ? { afterRename: die } : {}),
  },
});

const result = await cache.render({ voiceId: "stub-f1", text }, { jobId: "job-crash" });
console.log(JSON.stringify({ cached: result.cached, key: result.key, frames: result.info.frames }));
