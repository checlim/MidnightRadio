import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const tsx = join(repoRoot, "node_modules/.bin/tsx");

/** Run several copies of a TypeScript child script at once (real processes) and return each stdout. */
export function runConcurrently(script: string, argsPerChild: string[][]): Promise<string[]> {
  return Promise.all(
    argsPerChild.map(
      (args) =>
        new Promise<string>((ok, fail) => {
          execFile(tsx, [script, ...args], { cwd: repoRoot, timeout: 60_000 }, (err, stdout) =>
            err ? fail(err) : ok(stdout.trim()),
          );
        }),
    ),
  );
}
