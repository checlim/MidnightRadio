import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openDb } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_FILE, loadWorkerConfig } from "./config.js";
import { JobQueue } from "./jobs/queue.js";
import type { Logger } from "./log.js";
import { startWorker } from "./worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const mainTs = join(here, "main.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mr-worker-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const captureLog = () => {
  const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, fields: Record<string, unknown> = {}) => void lines.push({ level, msg, fields });
  const log: Logger = { info: at("info"), warn: at("warn"), error: at("error") };
  return { log, lines };
};

describe("loadWorkerConfig", () => {
  it("defaults to /data and a shutdown timeout under common platform kill timeouts", () => {
    expect(loadWorkerConfig({})).toEqual({ dataDir: "/data", shutdownTimeoutMs: 4_000 });
    expect(loadWorkerConfig({ DATA_DIR: " /tmp/x ", WORKER_SHUTDOWN_TIMEOUT_MS: "2500" })).toEqual({ dataDir: "/tmp/x", shutdownTimeoutMs: 2_500 });
  });

  it("rejects malformed values without echoing them", () => {
    expect(() => loadWorkerConfig({ WORKER_SHUTDOWN_TIMEOUT_MS: "soon" })).toThrow(
      "invalid worker configuration: WORKER_SHUTDOWN_TIMEOUT_MS must be a whole number of milliseconds",
    );
    expect(() => loadWorkerConfig({ WORKER_SHUTDOWN_TIMEOUT_MS: "5" })).toThrow(/between 100 and 120000/);
  });
});

describe("startWorker", () => {
  it("creates and migrates the database on the data volume, runs jobs, and stops cleanly", async () => {
    const { log, lines } = captureLog();
    const dataDir = join(dir, "nested", "data");
    const seen: string[] = [];
    const w = startWorker({
      env: { DATA_DIR: dataDir },
      log,
      pollMs: 5,
      createHandlers: () => ({ render: async ({ job }) => void seen.push(job.refId) }),
    });
    expect(existsSync(join(dataDir, DB_FILE))).toBe(true);
    const { id } = w.queue.enqueue("render", "c1");
    while (seen.length === 0) await sleep(5);
    await w.stop();
    expect(seen).toEqual(["c1"]);
    expect(lines.map((l) => l.msg)).toEqual(["worker started", "worker stopped"]);
    expect(lines[0]!.fields).toMatchObject({ jobKinds: ["render"], paidTts: false, paidLlm: false });

    const db = openDb(join(dataDir, DB_FILE)); // closed by stop(), reopenable
    expect(new JobQueue(db).get(id)!.state).toBe("done");
    db.close();
  });

  it("on stop, releases an in-flight job without using an attempt", async () => {
    const { log } = captureLog();
    let started = false;
    const w = startWorker({
      env: { DATA_DIR: dir },
      log,
      pollMs: 5,
      createHandlers: () => ({
        render: async ({ signal }) => {
          started = true;
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        },
      }),
    });
    const { id } = w.queue.enqueue("render", "c1");
    while (!started) await sleep(5);
    await w.stop();
    const db = openDb(join(dir, DB_FILE));
    expect(new JobQueue(db).get(id)).toMatchObject({ state: "queued", attempts: 0, leaseToken: null });
    db.close();
  });

  it("warns when no handlers are registered", async () => {
    const { log, lines } = captureLog();
    const w = startWorker({ env: { DATA_DIR: dir }, log, pollMs: 5 });
    await w.stop();
    expect(lines.find((l) => l.level === "warn")?.msg).toMatch(/no job handlers/);
  });

  it("logs handler errors with the job but without stack traces", async () => {
    const { log, lines } = captureLog();
    const w = startWorker({
      env: { DATA_DIR: dir },
      log,
      pollMs: 5,
      createHandlers: () => ({
        render: async () => {
          throw new Error("tts 503");
        },
      }),
    });
    const { id } = w.queue.enqueue("render", "c1");
    while (!lines.some((l) => l.msg === "job error")) await sleep(5);
    await w.stop();
    const e = lines.find((l) => l.msg === "job error")!;
    expect(e.fields).toEqual({ error: "Error", message: "tts 503", jobId: id, jobKind: "render" });
  });

  it("fails at boot on malformed budget caps", () => {
    expect(() => startWorker({ env: { DATA_DIR: dir, GLOBAL_DAILY_TTS_CHAR_LIMIT: "lots" }, log: captureLog().log })).toThrow(
      /GLOBAL_DAILY_TTS_CHAR_LIMIT must be a non-negative integer/,
    );
  });
});

describe("main.ts process", () => {
  const launch = (env: Record<string, string>) => {
    const child = spawn(process.execPath, ["--import", "tsx", mainTs], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((ok) => child.on("exit", (code) => ok(code)));
    const waitFor = async (text: string) => {
      const deadline = Date.now() + 20_000;
      while (!out.includes(text)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${text}"; got: ${out}`);
        await sleep(20);
      }
    };
    return { child, exited, waitFor, output: () => out };
  };

  it("starts, then exits 0 on SIGTERM after a clean shutdown", async () => {
    const p = launch({ DATA_DIR: dir });
    await p.waitFor('"msg":"worker started"');
    p.child.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    const msgs = p
      .output()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).msg);
    expect(msgs).toEqual(["worker started", "no job handlers registered; queued jobs will wait", "shutdown requested", "worker stopped"]);
    expect(existsSync(join(dir, DB_FILE))).toBe(true);
  }, 30_000);

  it("exits 1 with a logged reason on bad configuration, without echoing the value", async () => {
    const p = launch({ DATA_DIR: dir, GLOBAL_DAILY_LLM_TOKEN_LIMIT: "hunter2" });
    expect(await p.exited).toBe(1);
    const line = JSON.parse(p.output().trim().split("\n")[0]!);
    expect(line).toMatchObject({ level: "error", msg: "worker failed to start" });
    expect(line.message).toMatch(/GLOBAL_DAILY_LLM_TOKEN_LIMIT must be a non-negative integer/);
    expect(p.output()).not.toContain("hunter2");
  }, 30_000);
});
