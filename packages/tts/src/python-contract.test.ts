import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QwenTtsProvider } from "./qwen-provider.js";
import { TtsError } from "./provider.js";
import { RenderCache } from "./render-cache.js";
import { clipBytes, clonableStubCatalogue } from "./test-support/clonable-catalogue.js";
import { validateWav } from "./wav.js";

/**
 * The TypeScript provider against the real Python service (fake backend: tones, no model).
 * Needs `uv` and a Python 3.10+. Skipped without them, unless REQUIRE_PYTHON_CONTRACT=1, which makes
 * their absence a failure (set it in CI).
 */

const here = dirname(fileURLToPath(import.meta.url));
const serviceDir = resolve(here, "../../../services/local-audio");
const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
const required = process.env.REQUIRE_PYTHON_CONTRACT === "1";
const TOKEN = "contract-test-token-0123456789";
const catalogue = clonableStubCatalogue();

if (!hasUv && required) {
  describe("contract with the Python service", () => {
    it("needs uv, and REQUIRE_PYTHON_CONTRACT=1 is set", () => {
      throw new Error("uv is not installed, so the Python service contract cannot be tested");
    });
  });
}

describe.skipIf(!hasUv)("contract with the real Python service (fake backend)", () => {
  let dir: string;
  let child: ChildProcess;
  let baseUrl: string;
  const stderr: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-contract-"));
    await mkdir(join(dir, "clips"));
    for (const v of catalogue.voices) await writeFile(join(dir, v.clip.file), clipBytes(v.id));
    await writeFile(join(dir, "catalogue.json"), JSON.stringify(catalogue));

    child = spawn("uv", ["run", "--no-project", "--python", ">=3.10", "python", "-m", "local_audio", "--catalogue", join(dir, "catalogue.json"), "--backend", "fake", "--port", "0"], {
      cwd: serviceDir,
      env: { ...process.env, LOCAL_AUDIO_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // its own process group, so the whole tree can be stopped
    });
    child.stderr!.on("data", (d: Buffer) => stderr.push(d.toString()));
    baseUrl = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`the service did not start in time:\n${stderr.join("")}`)), 100_000);
      let buffer = "";
      child.stdout!.on("data", (d: Buffer) => {
        buffer += d.toString();
        const line = buffer.split("\n")[0]!;
        if (buffer.includes("\n")) {
          clearTimeout(timer);
          resolveUrl((JSON.parse(line) as { listening: string }).listening);
        }
      });
      child.on("exit", (code) => reject(new Error(`the service exited early (${code}):\n${stderr.join("")}`)));
    });
  }, 120_000);

  afterAll(async () => {
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
      if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    }
    await rm(dir, { recursive: true, force: true });
  });

  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof TtsError) return e;
      throw e;
    }
    throw new Error("expected a TtsError");
  };

  it("connects, verifying every voice's clip and transcript against the catalogue", async () => {
    const provider = await QwenTtsProvider.connect({ baseUrl, catalogue, token: TOKEN });
    expect(provider.identity).toMatchObject({ provider: "qwen3-tts", model: "fake-tts", revision: "fake-1" });
    expect((await provider.voices()).length).toBe(12);
  });

  it("refuses to connect without the token, or with a catalogue whose clip differs from the service's", async () => {
    expect(await failure(QwenTtsProvider.connect({ baseUrl, catalogue }))).toMatchObject({ kind: "rejected" });
    const changed = clonableStubCatalogue();
    changed.voices[2]!.clip.sha256 = "0".repeat(64);
    expect((await failure(QwenTtsProvider.connect({ baseUrl, catalogue: changed, token: TOKEN }))).message).toMatch(/reference clip for voice "stub-f1" differs/);
  });

  it("renders valid audio through the render cache, which the second run then serves from disk", async () => {
    const provider = await QwenTtsProvider.connect({ baseUrl, catalogue, token: TOKEN });
    const cache = new RenderCache({ dir: join(dir, "cache"), provider });
    const req = { voiceId: "stub-f1", text: "Good evening, listeners." };
    const first = await cache.render(req);
    expect(first.cached).toBe(false);
    expect(validateWav(await import("node:fs/promises").then((fs) => fs.readFile(first.path))).frames).toBe(3 * 350 * 24); // three words
    expect((await cache.render(req)).cached).toBe(true);
    const other = await cache.render({ voiceId: "stub-m1", text: "Good evening, listeners." });
    expect(other.key).not.toBe(first.key);
  });

  it("sends the same audio for the same request, and different audio for another voice", async () => {
    const provider = await QwenTtsProvider.connect({ baseUrl, catalogue, token: TOKEN });
    const a = await provider.synthesize({ voiceId: "stub-f1", text: "Hello there." });
    expect((await provider.synthesize({ voiceId: "stub-f1", text: "Hello there." })).equals(a)).toBe(true);
    expect((await provider.synthesize({ voiceId: "stub-m1", text: "Hello there." })).equals(a)).toBe(false);
  });

  it("maps the service's own errors: an unknown voice is refused before the request, bad input is rejected", async () => {
    const provider = await QwenTtsProvider.connect({ baseUrl, catalogue, token: TOKEN });
    expect(await failure(provider.synthesize({ voiceId: "nobody", text: "Hi" }))).toMatchObject({ kind: "rejected" });
    const res = await fetch(`${baseUrl}/tts`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ voiceId: "stub-f1", text: "Hi", pitch: 2 }) });
    expect(res.status).toBe(400);
  });

  it("serves sound effects as 48 kHz mono WAV (used by the foley task)", async () => {
    const res = await fetch(`${baseUrl}/sfx`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ prompt: "a heavy door creaking open", durationSec: 1, seed: 1 }) });
    expect(res.status).toBe(200);
    expect(validateWav(Buffer.from(await res.arrayBuffer()), { sampleRate: 48_000 }).frames).toBe(48_000);
  });

  it("refuses a request that names another host (DNS rebinding) or carries an Origin (a web page)", async () => {
    const send = (headers: Record<string, string>) =>
      new Promise<number>((resolveStatus, reject) => {
        const url = new URL(baseUrl);
        const req = httpRequest({ host: url.hostname, port: url.port, path: "/health", headers: { authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await send({ Host: "evil.example" })).toBe(403);
    expect(await send({ Origin: "https://evil.example" })).toBe(403);
    expect(await send({})).toBe(200);
  });

  it("is reported as not running, and not billed, once it has been stopped", async () => {
    const provider = await QwenTtsProvider.connect({ baseUrl, catalogue, token: TOKEN });
    process.kill(-child.pid!, "SIGTERM");
    await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
    expect(child.exitCode).toBe(0); // a clean shutdown on SIGTERM
    expect(await failure(provider.synthesize({ voiceId: "stub-f1", text: "Anyone there?" }))).toMatchObject({ kind: "unavailable", billed: false, retryable: true });
  }, 30_000);
});
