/**
 * Run the studio locally: the web app and the worker together, with generation enabled.
 *
 *   pnpm studio                 real providers (LLM key, Qwen3-TTS on LOCAL_AUDIO_URL)
 *   pnpm studio --stub          offline stand-in model and tone voices (no key, no audio models)
 *   pnpm studio --port 4000     the web app on another port (default 3000)
 *   pnpm studio --prod          build once and serve the production web app (use this on a server)
 *
 * Without --prod the web app is Next's development server, which only serves its scripts to pages
 * opened on this machine (localhost): opened from another address, the page loads but never
 * becomes interactive. On a server use --prod: no such check, faster, and no development tooling
 * exposed. Set UPLOAD_PASSKEY there, or anyone who finds the address can spend your LLM and GPU budget.
 *
 * Reads the repo's .env. Both processes get the same absolute DATA_DIR (default ./data), because
 * they run from different folders and a relative path would point them at different databases.
 * Ctrl+C stops both; if either stops on its own, the other is stopped too.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const { values: args } = parseArgs({ options: { stub: { type: "boolean", default: false }, prod: { type: "boolean", default: false }, port: { type: "string", default: "3000" } } });
const stub = args.stub;
const port = Number(args.port);
if (!/^\d+$/.test(args.port) || port < 1 || port > 65_535) {
  console.error(`studio: --port must be a whole number from 1 to 65535, not "${args.port}"`);
  process.exit(2);
}
const env = {
  ...process.env,
  GENERATION_ENABLED: "true",
  MIDNIGHT_STUB_PROVIDERS: stub ? "true" : (process.env.MIDNIGHT_STUB_PROVIDERS ?? "false"),
  DATA_DIR: resolve(root, process.env.DATA_DIR?.trim() || "./data"),
  ...(stub ? { GLOBAL_DAILY_TTS_CHAR_LIMIT: process.env.GLOBAL_DAILY_TTS_CHAR_LIMIT || "1000000", GLOBAL_DAILY_LLM_TOKEN_LIMIT: process.env.GLOBAL_DAILY_LLM_TOKEN_LIMIT || "10000000" } : {}),
};

console.log(`studio: ${stub ? "stub providers (tones, not real voices)" : "real providers"}; ${args.prod ? "production build" : "development server (this machine only)"}; data in ${env.DATA_DIR}; open http://localhost:${port}/studio`);
if (args.prod && !process.env.UPLOAD_PASSKEY?.trim()) {
  console.warn("studio: WARNING: UPLOAD_PASSKEY is not set, so anyone who can reach this port can upload books and spend your LLM and GPU budget. Set it in .env to a long random value (e.g. openssl rand -hex 24).");
}
if (args.prod) {
  console.log("studio: building the web app (a minute or two)…");
  const built = spawnSync("pnpm", ["--filter", "@midnight-radio/web", "build"], { cwd: root, env, stdio: "inherit" });
  if (built.status !== 0) {
    console.error("studio: the web app did not build; see the messages above");
    process.exit(built.status ?? 1);
  }
}

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
run("web", ["--filter", "@midnight-radio/web", args.prod ? "start" : "dev", "--port", String(port)]);
