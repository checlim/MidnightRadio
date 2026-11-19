import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_VOICE_CATALOGUE, requireClonable, type VoiceCatalogue } from "@midnight-radio/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planRender, renderSegments } from "./segments.js";
import { QwenTtsProvider } from "./qwen-provider.js";
import { RenderCache } from "./render-cache.js";
import { validateWav } from "./wav.js";

/**
 * End to end with the real model: TypeScript client and render cache, the Python service, and
 * Qwen3-TTS on this machine. Runs only when MR_QWEN_BASE names a local Base snapshot and the
 * service's .venv and the spike's reference clips exist. Takes about a minute.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serviceDir = resolve(here, "../../../services/local-audio");
const python = join(serviceDir, ".venv/bin/python");
const spike = join(serviceDir, "spike-output");
const BASE = process.env.MR_QWEN_BASE;
const ready = Boolean(BASE) && existsSync(python) && existsSync(join(spike, "ref-nobleman.wav")) && existsSync(join(spike, "ref-young-man.wav"));
const REF_TEXT = "Good evening. The night is cold, the road is long, and the old house waits at the end of it.";

describe.skipIf(!ready)("real Qwen3-TTS, end to end", () => {
  let dir: string;
  let child: ChildProcess;
  let baseUrl: string;
  let catalogue: VoiceCatalogue;
  const voices = ["nobleman", "young-man"];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-qwen-real-"));
    await mkdir(join(dir, "clips"));
    const entries = [];
    for (const id of voices) {
      const clip = await readFile(join(spike, `ref-${id}.wav`));
      await writeFile(join(dir, "clips", `${id}.wav`), clip);
      entries.push({ id, name: id, gender: "masculine" as const, ageBands: [], description: `Spike voice ${id}.`, clip: { file: `clips/${id}.wav`, sha256: createHash("sha256").update(clip).digest("hex"), transcript: REF_TEXT } });
    }
    // Two spike voices as the "reserved" pair is enough for this test; a real catalogue has many more.
    catalogue = requireClonable({ ...STUB_VOICE_CATALOGUE, reserved: { announcer: "nobleman", narrator: "young-man" }, voices: [...entries, { ...entries[0]!, id: "spare" }] });
    await writeFile(join(dir, "clips", "spare.wav"), await readFile(join(spike, "ref-nobleman.wav")));
    await writeFile(join(dir, "catalogue.json"), JSON.stringify(catalogue));

    child = spawn(python, ["-m", "local_audio", "--catalogue", join(dir, "catalogue.json"), "--backend", "qwen-mlx", "--tts-model", BASE!, "--port", "0"], {
      cwd: serviceDir,
      env: { ...process.env, HF_HUB_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr!.on("data", (d: Buffer) => stderr.push(d.toString()));
    baseUrl = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`service did not start:\n${stderr.join("")}`)), 120_000);
      let buffered = "";
      child.stdout!.on("data", (d: Buffer) => {
        buffered += d.toString();
        const lines = buffered.split("\n");
        if (lines.length < 2) return;
        // The announcement must be the only output; anything else on stdout is a bug in the service.
        clearTimeout(timer);
        try {
          ok((JSON.parse(lines[0]!) as { listening: string }).listening);
        } catch {
          fail(new Error(`the service printed something other than its announcement on stdout: ${JSON.stringify(lines[0])}`));
        }
      });
      child.on("exit", (code) => fail(new Error(`service exited (${code}):\n${stderr.join("")}`)));
    });
  }, 180_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("connects, renders verbatim book lines through the cache, and serves them from disk the second time", async () => {
    const provider = await QwenTtsProvider.connect({ baseUrl, catalogue, seed: 1940 });
    expect(provider.identity).toMatchObject({ provider: "qwen3-tts", model: "Qwen3-TTS-12Hz-1.7B-Base-bf16" });
    expect(provider.identity.settings.weightsSha256).toBe("81fb76175ff74e69be25fef2cc3e54f016df3034f1514c8e1c89da06a3510cff");

    const cache = new RenderCache({ dir: join(dir, "cache"), provider });
    const lines = [
      { id: "1", voiceId: "nobleman", text: "Welcome to my house! Enter freely and of your own will!" },
      { id: "2", voiceId: "young-man", text: "Count Dracula?" },
      { id: "3", voiceId: "nobleman", text: "I am Dracula; and I bid you welcome, Mr. Harker, to my house." },
    ];
    const plan = await planRender(cache, lines);
    expect(plan).toMatchObject({ toRender: 3, cachedRenders: 0, problems: [] });

    const started = Date.now();
    const first = await renderSegments(lines, { cache });
    const ms = Date.now() - started;
    expect(first.map((o) => o.status)).toEqual(["rendered", "rendered", "rendered"]);
    for (const o of first) {
      if (o.status === "failed") throw new Error(o.error.message);
      const info = validateWav(await readFile(o.result.path));
      expect(info.sampleRate).toBe(24_000);
      expect(info.durationMs).toBeGreaterThan(500);
    }
    // The estimate should be in the right range for this machine (within a factor of three).
    expect(ms).toBeLessThan(plan.estimatedRenderMs * 3);
    expect(ms).toBeGreaterThan(plan.estimatedRenderMs / 3);

    const second = await renderSegments(lines, { cache });
    expect(second.map((o) => o.status)).toEqual(["cached", "cached", "cached"]);
  }, 300_000);
});
