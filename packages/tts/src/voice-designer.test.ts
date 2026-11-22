import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TtsError } from "./provider.js";
import { DESIGN_SENTENCE, QwenVoiceDesigner, StubVoiceDesigner, VoiceDesignPinSchema, checkDesignedClip } from "./voice-designer.js";
import { encodeWav } from "./wav.js";

const TOKEN = "design-token-0123456789abcdef";
const PIN = { name: "design-model (float32)", revision: "design-rev-1", weightsSha256: "d".repeat(64) };
// Clamped like a recording that clips (Int16Array would wrap the values instead).
const tone = (seconds: number, amp = 0.3) =>
  encodeWav(Int16Array.from({ length: Math.round(seconds * 24_000) }, (_, i) => Math.max(-32768, Math.min(32767, Math.round(amp * 32767 * Math.sin((2 * Math.PI * 200 * i) / 24_000))))));

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TtsError) return e;
    throw e;
  }
  throw new Error("expected a TtsError");
};

interface Fake {
  url: string;
  requests: { url: string; body: unknown; auth: string | undefined }[];
  health: unknown;
  design: (res: ServerResponse) => void;
}
async function fake(): Promise<Fake> {
  const f: Fake = {
    url: "",
    requests: [],
    health: { apiVersion: 1, tts: null, voiceDesign: { model: PIN.name, revision: PIN.revision, weightsSha256: PIN.weightsSha256, sampleRate: 24_000, ready: true } },
    design: (res) => res.writeHead(200, { "content-type": "audio/wav", "x-model-revision": PIN.revision }).end(tone(4)),
  };
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      f.requests.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization });
      if (req.url === "/health") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(f.health));
      if (req.url === "/voice-design") return f.design(res);
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return f;
}

describe("checking a designed clip", () => {
  it("accepts an audible 2–20 s clip and says why it refuses any other", () => {
    expect(checkDesignedClip(tone(4))).toEqual({ ok: true, durationMs: 4000 });
    expect(checkDesignedClip(tone(1))).toMatchObject({ ok: false, reason: "1.0 s long; a reference clip needs 2 to 20 s" });
    expect(checkDesignedClip(tone(25))).toMatchObject({ ok: false, reason: /25\.0 s long/ });
    expect(checkDesignedClip(tone(4, 0.001))).toMatchObject({ ok: false, reason: /nearly silent/ });
    expect(checkDesignedClip(tone(4, 1.5))).toEqual({ ok: false, reason: "clips" });
    expect(checkDesignedClip(new Uint8Array(10))).toMatchObject({ ok: false, reason: /not a usable WAV/ });
    expect(checkDesignedClip(encodeWav(new Int16Array(24_000 * 4), 24_000))).toMatchObject({ ok: false, reason: /nearly silent/ });
  });
});

describe("the voice-design client", () => {
  it("connects to the pinned build, sends the description, the fixed sentence and the seed, and returns the clip", async () => {
    const f = await fake();
    const d = await QwenVoiceDesigner.connect({ baseUrl: f.url, pin: PIN });
    expect(d.identity).toEqual({ model: PIN.name, revision: PIN.revision, weightsSha256: PIN.weightsSha256 });
    const wav = await d.design({ instruct: "  An old nobleman; deep and slow.  ", text: DESIGN_SENTENCE, seed: 1940 });
    expect(checkDesignedClip(wav).ok).toBe(true);
    expect(f.requests.at(-1)).toMatchObject({ url: "/voice-design", body: { instruct: "An old nobleman; deep and slow.", text: DESIGN_SENTENCE, language: "English", seed: 1940 } });
  });

  it("refuses a server without voice design, still loading, or running another build", async () => {
    const f = await fake();
    const vd = (patch: object | null) => (f.health = { apiVersion: 1, tts: null, voiceDesign: patch && { model: PIN.name, revision: PIN.revision, weightsSha256: PIN.weightsSha256, sampleRate: 24_000, ready: true, ...patch } });
    const cases: [object | null, RegExp, boolean][] = [
      [null, /no voice-design model/, false],
      [{ ready: false, weightsSha256: null }, /not ready yet/, true],
      [{ model: "design-model (float16)" }, /designs voices with "design-model \(float16\)", not the pinned "design-model \(float32\)"/, false],
      [{ revision: "other" }, /revision "other" is not the pinned/, false],
      [{ weightsSha256: "e".repeat(64) }, /weights are not the pinned ones/, false],
      [{ sampleRate: 44_100 }, /44100 Hz/, false],
    ];
    for (const [patch, message, retryable] of cases) {
      vd(patch);
      const e = await failure(QwenVoiceDesigner.connect({ baseUrl: f.url, pin: PIN }));
      expect([e.message, e.retryable]).toEqual([expect.stringMatching(message), retryable]);
    }
  });

  it("applies the address rules, sends the token, and refuses a changed model, non-WAV answers and bad requests", async () => {
    expect(await failure(QwenVoiceDesigner.connect({ baseUrl: "https://gpu.example.org", pin: PIN }))).toMatchObject({ kind: "rejected" });
    expect(await failure(QwenVoiceDesigner.connect({ baseUrl: "http://gpu.example.org", token: TOKEN, pin: PIN }))).toMatchObject({ kind: "rejected" });
    const f = await fake();
    const d = await QwenVoiceDesigner.connect({ baseUrl: f.url, token: TOKEN, pin: PIN });
    expect(f.requests[0]!.auth).toBe(`Bearer ${TOKEN}`);
    for (const bad of [{ instruct: " ", text: "x", seed: 1 }, { instruct: "x".repeat(501), text: "x", seed: 1 }, { instruct: "x", text: "x", seed: -1 }]) {
      expect(await failure(d.design(bad))).toMatchObject({ kind: "rejected" });
    }
    f.design = (res) => res.writeHead(200, { "content-type": "audio/wav", "x-model-revision": "other" }).end(tone(4));
    expect((await failure(d.design({ instruct: "x", text: "x", seed: 1 }))).message).toMatch(/model changed while connected/);
    f.design = (res) => res.writeHead(200, { "content-type": "text/html", "x-model-revision": PIN.revision }).end("<html>");
    expect(await failure(d.design({ instruct: "x", text: "x", seed: 1 }))).toMatchObject({ kind: "invalid_output" });
    f.design = (res) => res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "busy", message: "the instruct text" } }));
    const busy = await failure(d.design({ instruct: "x", text: "x", seed: 1 }));
    expect([busy.kind, busy.retryable, busy.message.includes("the instruct text")]).toEqual(["unavailable", true, false]);
  });

  it("is pinned to the committed voice-design build", () => {
    const committed = VoiceDesignPinSchema.parse(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../assets/voices/voice-design.json"), "utf8")));
    expect(committed).toMatchObject({ name: "Qwen3-TTS-12Hz-1.7B-VoiceDesign (float32)", revision: "5ecdb67327fd37bb2e042aab12ff7391903235d3", weightsSha256: "391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522" });
  });
});

describe("the stub designer", () => {
  it("makes a usable, repeatable clip per description and seed, and silence on request", async () => {
    const d = new StubVoiceDesigner(new Set([7]));
    const a = await d.design({ instruct: "A", text: DESIGN_SENTENCE, seed: 1 });
    expect(checkDesignedClip(a).ok).toBe(true);
    expect((await d.design({ instruct: "A", text: DESIGN_SENTENCE, seed: 1 })).equals(a)).toBe(true);
    expect((await d.design({ instruct: "B", text: DESIGN_SENTENCE, seed: 1 })).equals(a)).toBe(false);
    expect(checkDesignedClip(await d.design({ instruct: "A", text: DESIGN_SENTENCE, seed: 7 })).ok).toBe(false);
  });
});
