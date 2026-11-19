import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

export interface ChildResult {
  /** Signal that ended the process (e.g. "SIGKILL"), or null for a normal exit. */
  signal: NodeJS.Signals | null;
  code: number | null;
  stdout: string;
}

/** Run a TypeScript child script as its own node process and report how it ended. Never rejects. */
export function runChild(script: string, args: string[]): Promise<ChildResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, ["--import", "tsx", join(here, script), ...args], { cwd: repoRoot, timeout: 60_000 }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { signal?: NodeJS.Signals; code?: number | string }) | null;
      resolveResult({
        signal: e?.signal ?? null,
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: stdout.trim(),
      });
    });
  });
}
