/**
 * Run the studio locally: the web app and the worker together, with generation enabled.
 *
 *   pnpm studio           real providers (LLM key, Qwen3-TTS on LOCAL_AUDIO_URL)
 *   pnpm studio --stub    offline stand-in model and tone voices (no key, no audio models)
 *
 * Reads the repo's .env. Both processes get the same absolute DATA_DIR (default ./data), because
 * they run from different folders and a relative path would point them at different databases.
 * Ctrl+C stops both; if either stops on its own, the other is stopped too.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const stub = process.argv.includes("--stub");
const env = {
  ...process.env,
  GENERATION_ENABLED: "true",
  MIDNIGHT_STUB_PROVIDERS: stub ? "true" : (process.env.MIDNIGHT_STUB_PROVIDERS ?? "false"),
  DATA_DIR: resolve(root, process.env.DATA_DIR?.trim() || "./data"),
  ...(stub ? { GLOBAL_DAILY_TTS_CHAR_LIMIT: process.env.GLOBAL_DAILY_TTS_CHAR_LIMIT || "1000000", GLOBAL_DAILY_LLM_TOKEN_LIMIT: process.env.GLOBAL_DAILY_LLM_TOKEN_LIMIT || "10000000" } : {}),
};

console.log(`studio: ${stub ? "stub providers (tones, not real voices)" : "real providers"}; data in ${env.DATA_DIR}; open http://localhost:3000/studio`);

const children: ChildProcess[] = [];
let stopping = false;
function run(name: string, args: string[]): void {
  const child = spawn("pnpm", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => `[${name}] ${l}\n`)
      .join("");
  child.stdout!.on("data", (c: Buffer) => process.stdout.write(prefix(c)));
  child.stderr!.on("data", (c: Buffer) => process.stderr.write(prefix(c)));
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`studio: ${name} stopped (${code ?? "signal"}); stopping the rest`);
      stop(code ?? 1);
    }
  });
  children.push(child);
}
function stop(code: number): void {
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run("worker", ["--filter", "@midnight-radio/worker", "start"]);
run("web", ["--filter", "@midnight-radio/web", "dev"]);
