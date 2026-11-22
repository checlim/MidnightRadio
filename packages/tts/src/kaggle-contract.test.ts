import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TtsError } from "./provider.js";
import { QwenTtsProvider } from "./qwen-provider.js";
import { DESIGN_SENTENCE, QwenVoiceDesigner, checkDesignedClip } from "./voice-designer.js";
import { clonableStubCatalogue, writeClips } from "./test-support/clonable-catalogue.js";
import { validateWav } from "./wav.js";

/**
 * The TypeScript client against the real Kaggle server file (services/local-audio/kaggle/qwen_tts_server.py),
 * with a stand-in model in place of Qwen3-TTS, so no GPU is needed: the wire format, the token, the
 * model-name and weights pins, and the clips travelling with each line. Needs uv and Python 3.10+;
 * skipped without them unless REQUIRE_PYTHON_CONTRACT=1.
 */

const kaggleDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../services/local-audio/kaggle");
const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
if (process.env.REQUIRE_PYTHON_CONTRACT === "1" && !hasUv) throw new Error("REQUIRE_PYTHON_CONTRACT=1 but uv is not installed");
const TOKEN = "kaggle-contract-token-0123456789";
const REVISION = "fd4b254389122332181a7c3db7f27e918eec64e3";
const WEIGHTS = "38fc7fc51c5e776e840414b6fd443962e9411b9654888fd7913e4da643cb857c";

// The stand-in model: a tone whose pitch depends on the reference clip, so voices sound different.
const LAUNCHER = `
import json, math, os, sys
sys.path.insert(0, ".")
import qwen_tts_server as q
class Model:
    def create_prompt(self, samples, sample_rate, ref_text):
        return int(sum(abs(s) for s in samples) * 1000)
    def generate(self, text, language, prompt, seed):
        f = 180 + prompt % 300 + seed % 7
        return [0.3 * math.sin(2 * math.pi * f * i / 24000) for i in range(2400 + 120 * len(text))], 24000
class Designer:
    def generate_design(self, instruct, text, language, seed):
        f = 120 + sum(map(ord, instruct)) % 200 + seed % 5
        return [0.3 * math.sin(2 * math.pi * f * i / 24000) for i in range(24000 * 3)], 24000
server = q.Server(q.Config(token=os.environ["TTS_SERVICE_TOKEN"], port=0), load_model=lambda c: q.LoadedModel(Model(), q.REVISION, q.EXPECTED_WEIGHTS_SHA256), load_design_model=lambda c: q.LoadedModel(Designer(), q.DESIGN_REVISION, q.DESIGN_EXPECTED_WEIGHTS_SHA256))
server.start_loading()
import time
for _ in range(100):
    if server.ready and server.design_ready:
        break
    time.sleep(0.1)
print(json.dumps({"listening": "http://127.0.0.1:%d" % server.port}), flush=True)
server.serve_forever()
`;

describe.skipIf(!hasUv)("contract with the Kaggle speech server (stand-in model)", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let clipDir: string;
  const pinned = (name: string) => clonableStubCatalogue({ models: [{ role: "voice-clone", name, revision: REVISION, weightsSha256: WEIGHTS }] });
  const catalogue = pinned("Qwen3-TTS-12Hz-1.7B-Base (float32)");
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof TtsError) return e;
      throw e;
    }
    throw new Error("expected a TtsError");
  };

  beforeAll(async () => {
    clipDir = await mkdtemp(join(tmpdir(), "mr-kaggle-"));
    await writeClips(clipDir, catalogue);
    child = spawn("uv", ["run", "--no-project", "--python", ">=3.10", "python", "-c", LAUNCHER], { cwd: kaggleDir, env: { ...process.env, TTS_SERVICE_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stderr: string[] = [];
    child.stderr!.on("data", (d: Buffer) => stderr.push(d.toString()));
    baseUrl = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`the server did not start:\n${stderr.join("")}`)), 100_000);
      let buffer = "";
      child.stdout!.on("data", (d: Buffer) => {
        buffer += d.toString();
        if (buffer.includes("\n")) {
          clearTimeout(timer);
          ok((JSON.parse(buffer.split("\n")[0]!) as { listening: string }).listening);
        }
      });
      child.on("exit", (code) => fail(new Error(`the server exited (${code}):\n${stderr.join("")}`)));
    });
  }, 120_000);

  afterAll(async () => {
    if (child?.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await rm(clipDir, { recursive: true, force: true });
  });

  it("connects when the server runs the pinned build and precision, and renders each voice from its own clip", async () => {
    const provider = await QwenTtsProvider.connect({ baseUrl, catalogue, clipDir, token: TOKEN, seed: 3 });
    expect(provider.identity).toMatchObject({ model: "Qwen3-TTS-12Hz-1.7B-Base (float32)", revision: REVISION, settings: { weightsSha256: WEIGHTS, seed: 3 } });
    const a = await provider.synthesize({ voiceId: "stub-f1", text: "Welcome to my house!" });
    expect(validateWav(a, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 }).frames).toBe(2400 + 120 * 20);
    expect((await provider.synthesize({ voiceId: "stub-f1", text: "Welcome to my house!" })).equals(a)).toBe(true);
    expect((await provider.synthesize({ voiceId: "stub-m1", text: "Welcome to my house!" })).equals(a)).toBe(false);
  });

  it("refuses another precision than the catalogue pins, a wrong token and no token", async () => {
    expect((await failure(QwenTtsProvider.connect({ baseUrl, catalogue: pinned("Qwen3-TTS-12Hz-1.7B-Base (float16)"), clipDir, token: TOKEN }))).message).toMatch(/runs "Qwen3-TTS-12Hz-1.7B-Base \(float32\)", not the "Qwen3-TTS-12Hz-1.7B-Base \(float16\)"/);
    expect(await failure(QwenTtsProvider.connect({ baseUrl, catalogue, clipDir, token: "wrong-token-0123456789abcdef" }))).toMatchObject({ kind: "rejected" });
    expect(await failure(QwenTtsProvider.connect({ baseUrl, catalogue, clipDir }))).toMatchObject({ kind: "rejected" });
  });

  it("designs a voice with the pinned voice-design build, and the clip passes the reference checks", async () => {
    const pin = { name: "Qwen3-TTS-12Hz-1.7B-VoiceDesign (float32)", revision: "5ecdb67327fd37bb2e042aab12ff7391903235d3", weightsSha256: "391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522" };
    const designer = await QwenVoiceDesigner.connect({ baseUrl, token: TOKEN, pin });
    const a = await designer.design({ instruct: "An aged nobleman; deep, slow and courtly.", text: DESIGN_SENTENCE, seed: 1940 });
    expect(checkDesignedClip(a)).toEqual({ ok: true, durationMs: 3000 });
    expect((await designer.design({ instruct: "A young maid; bright and quick.", text: DESIGN_SENTENCE, seed: 1940 })).equals(a)).toBe(false);
    expect((await failure(QwenVoiceDesigner.connect({ baseUrl, token: TOKEN, pin: { ...pin, name: "Qwen3-TTS-12Hz-1.7B-VoiceDesign (float16)" } }))).message).toMatch(/not the pinned/);
  });

  it("refuses requests from a web page", async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});
