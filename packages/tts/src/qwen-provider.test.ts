import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { ASSUMED_MS_PER_CHAR, MAX_CHUNK_CHARS, QwenTtsProvider, assertServiceUrl, loadQwenConfig, splitSpeechText, type QwenTtsOptions } from "./qwen-provider.js";
import { TtsError } from "./provider.js";
import { RenderCache } from "./render-cache.js";
import { renderSegments } from "./segments.js";
import { StubProvider } from "./stub.js";
import { clipBytes, clonableStubCatalogue, CLIP_TRANSCRIPT, writeClips } from "./test-support/clonable-catalogue.js";
import { closedPort, startFakeService, type FakeService, type FakeState } from "./test-support/fake-audio-service.js";
import { validateWav } from "./wav.js";

const TOKEN = "service-token-0123456789abcdef";
const catalogue = clonableStubCatalogue();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let service: FakeService;
let clipDir: string;
beforeAll(async () => {
  clipDir = await mkdtemp(join(tmpdir(), "mr-clips-"));
  await writeClips(clipDir, catalogue);
});
afterAll(() => rm(clipDir, { recursive: true, force: true }));
/** connect() with the test clips; `extra` overrides any option. */
const connect = (extra: Partial<QwenTtsOptions> & { baseUrl: string }) => QwenTtsProvider.connect({ catalogue, clipDir, ...extra });
const open = async (state: Partial<FakeState> = {}, opts: Partial<QwenTtsOptions> = {}) => {
  service = await startFakeService(catalogue, state);
  return { provider: await connect({ baseUrl: service.url, ...opts }), service };
};
afterEach(async () => service?.close());

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TtsError) return e;
    throw e;
  }
  throw new Error("expected a TtsError");
};
const say = (text: string, voiceId = "stub-f1") => ({ voiceId, text });

describe("connecting", () => {
  it("verifies the service against the catalogue and takes its identity from the service", async () => {
    const { provider } = await open();
    expect(provider.identity).toEqual({ provider: "qwen3-tts", model: "fake-tts", revision: "fake-1", settings: { seed: 0, apiVersion: 1, sampleRate: 24_000 } });
    expect((await provider.voices()).map((v) => v.id)).toEqual(catalogue.voices.map((v) => v.id));
    expect(service.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /health"]);
  });

  it("gives each voice a fingerprint built from its clip and transcript hashes", async () => {
    const { provider } = await open();
    const fp = provider.voiceFingerprint("stub-f1");
    expect(fp).toBe(`clip:${catalogue.voices.find((v) => v.id === "stub-f1")!.clip.sha256}:${sha(CLIP_TRANSCRIPT)}`);
    expect(provider.voiceFingerprint("stub-m1")).not.toBe(fp);
    expect(() => provider.voiceFingerprint("nobody")).toThrow(/unknown voice/);
  });

  it("estimates render time from characters, using the assumed speed unless told otherwise", async () => {
    expect((await open()).provider.estimateRenderMs(100)).toBe(100 * ASSUMED_MS_PER_CHAR);
    await service.close();
    expect((await open({}, { msPerChar: 12.5 })).provider.estimateRenderMs(100)).toBe(1250);
  });

  it("sends the access token only when one is configured", async () => {
    await open();
    expect(service.requests[0]!.headers.authorization).toBeUndefined();
    await service.close();
    const { provider } = await open({ token: TOKEN }, { token: TOKEN });
    expect(service.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    await provider.synthesize(say("Hello there."));
    expect(service.requests[1]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  const refusals: [string, Partial<FakeState>, RegExp, boolean][] = [
    ["an answer from some other kind of server", { healthBody: JSON.stringify({ hello: "world" }) }, /unreadable/, false],
    ["a different API version", { apiVersion: 2 }, /API version 2, expected 1/, false],
    ["no speech model", { tts: null }, /no speech model ready/, true],
    ["a speech model that is still loading", { tts: { sampleRate: 24_000, ready: false } }, /no speech model ready/, true],
    ["a server still loading its model, with no weights hash yet", { healthBody: JSON.stringify({ apiVersion: 1, tts: { model: "m", revision: "r", weightsSha256: null, sampleRate: 24_000, ready: false } }) }, /no speech model ready/, true],
    ["a speech model at the wrong rate", { tts: { sampleRate: 44_100, ready: true } }, /44100 Hz/, false],
    ["an error page", { healthStatus: 500, healthBody: "oops" }, /HTTP 500/, true],
    ["an unreadable answer", { healthBody: "not json" }, /unreadable/, false],
  ];
  it.each(refusals)("refuses %s", async (_label, state, message, retryable) => {
    service = await startFakeService(catalogue, state);
    const e = await failure(connect({ baseUrl: service.url }));
    expect(e).toMatchObject({ kind: "unavailable", billed: false, retryable });
    expect(e.message).toMatch(message);
  });

  it("checks every reference clip on disk against the catalogue before talking to the service", async () => {
    service = await startFakeService(catalogue);
    const dir = await mkdtemp(join(tmpdir(), "mr-clips-bad-"));
    try {
      await writeClips(dir, catalogue);
      await writeFile(join(dir, "clips/stub-m1.wav"), clipBytes("someone else"));
      expect(await failure(connect({ baseUrl: service.url, clipDir: dir }))).toMatchObject({ kind: "rejected", message: 'the reference clip for voice "stub-m1" does not match the catalogue\'s hash' });
      await rm(join(dir, "clips/stub-f1.wav"));
      expect((await failure(connect({ baseUrl: service.url, clipDir: dir }))).message).toMatch(/reference clip for voice "stub-f1" is missing/);
      const escaping = clonableStubCatalogue();
      escaping.voices[0]!.clip.file = "../outside.wav";
      expect((await failure(connect({ baseUrl: service.url, clipDir: dir, catalogue: escaping }))).message).toMatch(/cannot be used for cloning|outside the catalogue folder/); // the catalogue schema refuses ".." first; the folder check is a second line
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(service.requests).toEqual([]);
  });

  it("pins the model name (build and precision): refuses another one", async () => {
    const pinned = clonableStubCatalogue({ models: [{ role: "voice-clone", name: "Qwen3-TTS-12Hz-1.7B-Base (float32)", revision: "fake-1" }] });
    service = await startFakeService(pinned, { model: "Qwen3-TTS-12Hz-1.7B-Base (float16)" });
    expect((await failure(connect({ baseUrl: service.url, catalogue: pinned }))).message).toBe('the speech service runs "Qwen3-TTS-12Hz-1.7B-Base (float16)", not the "Qwen3-TTS-12Hz-1.7B-Base (float32)" the catalogue pins');
    service.state.model = "Qwen3-TTS-12Hz-1.7B-Base (float32)";
    expect((await connect({ baseUrl: service.url, catalogue: pinned })).identity.model).toBe("Qwen3-TTS-12Hz-1.7B-Base (float32)");
  });

  it("refuses a model revision other than the one the catalogue pins, and accepts the pinned one", async () => {
    const pinned = clonableStubCatalogue({ models: [{ role: "voice-clone", name: "fake-tts", revision: "rev-A" }] });
    service = await startFakeService(pinned, { revision: "rev-B" });
    const e = await failure(connect({ baseUrl: service.url, catalogue: pinned }));
    expect(e.message).toMatch(/revision "rev-B" is not the one the catalogue pins \("rev-A"\)/);
    service.state.revision = "rev-A";
    expect((await connect({ baseUrl: service.url, catalogue: pinned })).identity.revision).toBe("rev-A");
  });

  it("pins the weights: refuses different or unreported weights when the catalogue pins a hash, and puts the hash in the identity", async () => {
    const weights = sha("the pinned weights");
    const pinned = clonableStubCatalogue({ models: [{ role: "voice-clone", name: "fake-tts", revision: "fake-1", weightsSha256: weights }] });
    service = await startFakeService(pinned, { tts: { sampleRate: 24_000, ready: true, weightsSha256: sha("other weights") } });
    expect((await failure(connect({ baseUrl: service.url, catalogue: pinned }))).message).toMatch(/weights \([0-9a-f]{12}\) are not the ones the catalogue pins/);
    service.state.tts = { sampleRate: 24_000, ready: true };
    expect((await failure(connect({ baseUrl: service.url, catalogue: pinned }))).message).toMatch(/weights \(not reported\)/);
    service.state.tts = { sampleRate: 24_000, ready: true, weightsSha256: weights };
    const provider = await connect({ baseUrl: service.url, catalogue: pinned });
    expect(provider.identity.settings).toMatchObject({ weightsSha256: weights });
  });

  it("gives renders from different weights different cache keys", async () => {
    service = await startFakeService(catalogue, { tts: { sampleRate: 24_000, ready: true, weightsSha256: sha("weights A") } });
    const a = await connect({ baseUrl: service.url });
    service.state.tts = { sampleRate: 24_000, ready: true, weightsSha256: sha("weights B") };
    const b = await connect({ baseUrl: service.url });
    const { renderCacheKey } = await import("./cache-key.js");
    expect(renderCacheKey(a, say("Hello."))).not.toBe(renderCacheKey(b, say("Hello.")));
  });

  it("refuses a token the service does not accept, and a catalogue that cannot be cloned from", async () => {
    service = await startFakeService(catalogue, { token: TOKEN });
    const e = await failure(connect({ baseUrl: service.url, token: "wrong-token-value-123456" }));
    expect(e).toMatchObject({ kind: "rejected", retryable: false });
    expect(e.message).toMatch(/LOCAL_AUDIO_TOKEN/);
    expect(e.message).not.toContain("wrong-token-value");
    expect(await failure(connect({ baseUrl: service.url, catalogue: { ...catalogue, voices: catalogue.voices.map(({ clip: _c, ...v }) => v) } as never, token: TOKEN }))).toMatchObject({ kind: "rejected" });
  });

  it("reports a service that is not running as retryable, and not as billed", async () => {
    const port = await closedPort();
    const e = await failure(connect({ baseUrl: `http://127.0.0.1:${port}` }));
    expect(e).toMatchObject({ kind: "unavailable", billed: false, retryable: true });
    expect(e.message).toMatch(/not running/);
  });
});

describe("where speech may be sent", () => {
  it.each([
    ["http://127.0.0.1:8765", undefined],
    ["http://localhost:8765", undefined],
    ["http://[::1]:8765", undefined],
    ["https://abc.trycloudflare.com", TOKEN],
    ["https://gpu.example.org:8443/speech", TOKEN],
  ])("accepts %s", (url, token) => {
    expect(() => assertServiceUrl(url, token)).not.toThrow();
  });
  it.each([
    ["http://example.com:8765", TOKEN, /must be https unless/],
    ["http://192.168.1.20:8765", TOKEN, /must be https unless/],
    ["https://abc.trycloudflare.com", undefined, /needs LOCAL_AUDIO_TOKEN \(at least 16 characters\)/],
    ["https://abc.trycloudflare.com", "too-short", /needs LOCAL_AUDIO_TOKEN/],
    ["https://user:pass@abc.trycloudflare.com", TOKEN, /must not contain credentials/],
    ["https://abc.trycloudflare.com/?key=1", TOKEN, /query or fragment/],
    ["ftp://127.0.0.1", TOKEN, /must be https/],
    ["not a url", TOKEN, /not a valid URL/],
    ["", TOKEN, /not a valid URL/],
  ] as const)("refuses %s", async (url, token, message) => {
    expect(() => assertServiceUrl(url, token)).toThrow(message);
    expect(await failure(connect({ baseUrl: url, token }))).toMatchObject({ kind: "rejected" });
  });
  it("talks to a server given with a trailing slash", async () => {
    service = await startFakeService(catalogue);
    await expect(connect({ baseUrl: `${service.url}/` })).resolves.toBeDefined();
    expect(service.requests.map((r) => r.url)).toEqual(["/health"]);
  });
});

describe("rendering", () => {
  it("returns the service's WAV, sending the text as given, the language, the seed and the voice's own clip and transcript", async () => {
    const { provider } = await open({}, { seed: 42 });
    const wav = await provider.synthesize({ voiceId: "stub-f1", text: "  “Welcome,” he said.\n", delivery: "sinister" });
    expect(validateWav(wav).frames).toBeGreaterThan(0);
    const sent = service.requests.at(-1)!;
    expect(sent.method).toBe("POST");
    expect(sent.headers["content-type"]).toBe("application/json");
    // No voice id and no delivery hint: the server only ever sees a clip to clone (Task 5.1, option a).
    expect(sent.body).toEqual({ text: "  “Welcome,” he said.\n", language: "English", seed: 42, reference: { audio: clipBytes("stub-f1").toString("base64"), text: CLIP_TRANSCRIPT } });
    expect(provider.identity.settings).toMatchObject({ seed: 42 });
    await provider.synthesize(say("Another voice.", "stub-m1"));
    expect((service.requests.at(-1)!.body as { reference: { audio: string } }).reference.audio).toBe(clipBytes("stub-m1").toString("base64"));
  });

  it("refuses an invalid request or an unknown voice without contacting the service", async () => {
    const { provider } = await open();
    const before = service.requests.length;
    expect(await failure(provider.synthesize(say("Hi", "nobody")))).toMatchObject({ kind: "rejected", billed: false, retryable: false });
    expect(await failure(provider.synthesize(say("   ")))).toMatchObject({ kind: "rejected" });
    expect(await failure(provider.synthesize({ voiceId: "stub-f1", text: "Hi", extra: 1 } as never))).toMatchObject({ kind: "rejected" });
    expect(await failure(provider.synthesize(say("Hi"), { signal: AbortSignal.abort() }))).toMatchObject({ kind: "aborted", billed: false });
    expect(service.requests.length).toBe(before);
  });

  describe("maps each way the service can fail to the right kind of error", () => {
    const respond = (status: number, code: string) => (_req: unknown, res: import("node:http").ServerResponse) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { code, message: "details that must not be repeated" } }));
      return true;
    };
    it.each([
      [400, "bad_request", "rejected", false, false],
      [404, "not_found", "rejected", false, false],
      [411, "length_required", "rejected", false, false],
      [413, "too_large", "rejected", false, false],
      [415, "unsupported_media_type", "rejected", false, false],
      [401, "unauthorized", "rejected", false, false],
      [403, "bad_host", "rejected", false, false],
      [503, "busy", "unavailable", false, true],
      [503, "not_ready", "unavailable", false, true],
      [500, "internal", "service_error", true, true],
      [502, "model_failed", "service_error", true, true],
    ] as const)("HTTP %i (%s) is %s, billed=%s, retryable=%s", async (status, code, kind, billed, retryable) => {
      const { provider, service } = await open();
      service.state.tts_handler = respond(status, code);
      const e = await failure(provider.synthesize(say("Hello.")));
      expect(e).toMatchObject({ kind, billed, retryable });
      expect(e.message).not.toContain("details that must not be repeated");
    });

    it("never repeats an unexpected error code from the service", async () => {
      const { provider, service } = await open();
      service.state.tts_handler = respond(500, "../../etc/passwd; DROP TABLE");
      const e = await failure(provider.synthesize(say("Hello.")));
      expect(e.message).toBe("the speech service failed (HTTP 500, unknown)");
    });

    it("rejects an answer that is not WAV audio", async () => {
      const { provider, service } = await open();
      service.state.tts_handler = (_r, res) => (res.writeHead(200, { "content-type": "text/html", "x-model-revision": "fake-1" }).end("<html>"), true);
      expect(await failure(provider.synthesize(say("Hello.")))).toMatchObject({ kind: "invalid_output", billed: true, retryable: true });
    });

    it("refuses audio from a different model revision than the one connected to", async () => {
      const { provider, service } = await open();
      service.state.revision = "fake-2"; // the service was restarted with other weights
      const e = await failure(provider.synthesize(say("Hello.")));
      expect(e).toMatchObject({ kind: "unavailable", billed: true, retryable: false });
      expect(e.message).toMatch(/model changed while connected \(now "fake-2"\)/);
      service.state.tts_handler = (_r, res) => (res.writeHead(200, { "content-type": "audio/wav" }).end(Buffer.alloc(10)), true); // no revision header at all
      expect(await failure(provider.synthesize(say("Hello.")))).toMatchObject({ kind: "unavailable", retryable: false });
    });

    it("refuses audio that is too large, whether declared or streamed", async () => {
      const { provider, service } = await open({}, { maxWavBytes: 2_000 });
      service.state.tts_handler = (_r, res) => (res.writeHead(200, { "content-type": "audio/wav", "x-model-revision": "fake-1", "content-length": "5000" }).end(Buffer.alloc(5000, 1)), true);
      expect(await failure(provider.synthesize(say("Hello.")))).toMatchObject({ kind: "invalid_output" });
      service.state.tts_handler = (_r, res) => {
        res.writeHead(200, { "content-type": "audio/wav", "x-model-revision": "fake-1" }); // chunked: no length up front
        res.write(Buffer.alloc(1500, 1));
        setTimeout(() => res.end(Buffer.alloc(1500, 1)), 20);
        return true;
      };
      expect(await failure(provider.synthesize(say("Hello.")))).toMatchObject({ kind: "invalid_output" });
    });

    it("treats a connection dropped mid-answer as possibly billed and worth retrying", async () => {
      const { provider, service } = await open();
      service.state.tts_handler = (_r, res) => {
        res.writeHead(200, { "content-type": "audio/wav", "x-model-revision": "fake-1", "content-length": "100000" });
        res.write(Buffer.alloc(500, 1));
        setTimeout(() => res.destroy(), 20);
        return true;
      };
      expect(await failure(provider.synthesize(say("Hello.")))).toMatchObject({ kind: "unavailable", billed: true, retryable: true });
    });

    it("times out a service that does not answer, as billed and retryable", async () => {
      const { provider, service } = await open({}, { timeoutMs: 150 });
      service.state.tts_handler = () => true; // never responds
      const started = Date.now();
      expect(await failure(provider.synthesize(say("Hello.")))).toMatchObject({ kind: "timeout", billed: true, retryable: true });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("stops on the caller's abort, treating the render as possibly still running", async () => {
      const { provider, service } = await open();
      service.state.tts_handler = () => true;
      const ctrl = new AbortController();
      const running = failure(provider.synthesize(say("Hello."), { signal: ctrl.signal }));
      setTimeout(() => ctrl.abort(), 50);
      expect(await running).toMatchObject({ kind: "aborted", billed: true, retryable: false });
    });

    it("reports a service that stopped running after connecting as retryable and not billed", async () => {
      const { provider, service } = await open();
      await service.close();
      expect(await failure(provider.synthesize(say("Hello.")))).toMatchObject({ kind: "unavailable", billed: false, retryable: true });
    });
  });

  it("never follows a redirect, so the token cannot be sent to another address", async () => {
    let reached = 0;
    const other = createServer((_req, res) => {
      reached++;
      res.writeHead(200).end("hello");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const { provider, service } = await open({ token: TOKEN }, { token: TOKEN });
    service.state.tts_handler = (_r, res) => (res.writeHead(302, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal` }).end(), true);
    const e = await failure(provider.synthesize(say("Hello.")));
    expect(e.kind).toBe("unavailable");
    expect(reached).toBe(0);
    other.close();
  });

  it("never puts the token in an error message", async () => {
    const { provider, service } = await open({ token: TOKEN }, { token: TOKEN });
    const messages: string[] = [];
    for (const handler of [
      (_r: unknown, res: import("node:http").ServerResponse) => (res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "internal", message: TOKEN } })), true),
      (_r: unknown, res: import("node:http").ServerResponse) => (res.writeHead(200, { "content-type": "text/plain" }).end(TOKEN), true),
      (_r: unknown, res: import("node:http").ServerResponse) => (res.destroy(), true),
    ]) {
      service.state.tts_handler = handler;
      messages.push((await failure(provider.synthesize(say("Hello.")))).message);
    }
    expect(messages.join("\n")).not.toContain(TOKEN);
  });
});

describe("long lines", () => {
  // About 750 characters of prose: sentences of varied length, curly quotes, an ellipsis.
  const SENTENCES = [
    "The night was cold and the road was long, and the carriage climbed between the dark pines while the wind moved in the branches far above us.",
    "\u201cWelcome to my house!\u201d said the Count, and he stood aside to let me pass.",
    "Far below, a river ran black under the moon\u2026 and the driver said nothing at all.",
    "Every mile the hills grew steeper and the sky grew lower, until the stars were hidden and only the lamps showed the way ahead.",
    "At last the walls of an old castle rose out of the dark, and I knew that I had come to the end of my journey.",
    "I cannot say how long I stood there before the great door opened.",
  ];
  const LONG = SENTENCES.join(" ").repeat(2);

  it("keeps a line of up to 600 characters whole", () => {
    expect(MAX_CHUNK_CHARS).toBe(600);
    const exact = "x".repeat(600);
    expect(splitSpeechText(exact)).toEqual([exact]);
    expect(splitSpeechText("Hello.")).toEqual(["Hello."]);
  });

  it("cuts at sentence ends, then spaces, then at a fixed length, and the parts join back exactly", () => {
    const parts = splitSpeechText(LONG);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(LONG);
    for (const p of parts.slice(0, -1)) {
      expect(p.length).toBeLessThanOrEqual(600);
      expect(p).toMatch(/[.!?\u2026]["'\u201d\u2019]*\s+$/); // every cut follows a sentence end
    }
    // No sentence end in reach: the cut goes after the last space.
    const words = "word ".repeat(200);
    const byWords = splitSpeechText(words);
    expect(byWords.join("")).toBe(words);
    expect(byWords[0]).toBe("word ".repeat(120));
    // One unbroken token: cut at 600 characters.
    const token = "a".repeat(1_500);
    expect(splitSpeechText(token).map((p) => p.length)).toEqual([600, 600, 300]);
    // A cut never separates the halves of a surrogate pair.
    const emoji = "\u{1F47B}".repeat(400); // 800 UTF-16 units
    const ghostly = splitSpeechText(emoji);
    expect(ghostly.join("")).toBe(emoji);
    expect(ghostly.every((p) => !/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(p))).toBe(true);
    // A part that would be only whitespace joins its neighbour.
    const trailing = `${"b".repeat(600)}${" ".repeat(10)}`;
    expect(splitSpeechText(trailing)).toEqual([trailing]);
  });

  it("property: any text splits into non-blank parts that join back exactly, each at most `max` characters apart from whitespace folded in at its ends", () => {
    const piece = fc.constantFrom("A", "b", " ", "  ", "\n", ".", "!", "?", "\u2026", "\u201d", "\u2019", ",", "\u{1F47B}", "word", "x".repeat(40));
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 400 }), fc.integer({ min: 2, max: 700 }), (pieces, max) => {
        const text = `${pieces.join("")}z`; // never blank, as a valid request
        const parts = splitSpeechText(text, max);
        expect(parts.join("")).toBe(text);
        for (const p of parts) {
          expect(p).toMatch(/\S/);
          expect(p.trim().length).toBeLessThanOrEqual(max);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("renders a long line part by part with the same clip and settings, and returns one valid WAV of all their audio", async () => {
    const { provider } = await open({}, { seed: 9 });
    const wav = await provider.synthesize({ voiceId: "stub-f1", text: LONG, delivery: "urgent" });
    const sent = service.requests.filter((r) => r.url === "/tts").map((r) => r.body as { text: string; language: string; seed: number; reference: { audio: string; text: string } });
    const parts = splitSpeechText(LONG);
    expect(sent.map((b) => b.text)).toEqual(parts); // in order, each part once
    expect(sent.map((b) => b.text).join("")).toBe(LONG);
    for (const b of sent) expect(b).toEqual({ text: b.text, language: "English", seed: 9, reference: { audio: clipBytes("stub-f1").toString("base64"), text: CLIP_TRANSCRIPT } });
    // The result is a valid WAV whose samples are each part's samples, in order.
    const info = validateWav(wav);
    const stub = new StubProvider();
    const expected = Buffer.concat(
      await Promise.all(
        parts.map(async (text) => {
          const one = await stub.synthesize({ voiceId: "stub-f1", text });
          const i = validateWav(one);
          return one.subarray(i.dataOffset, i.dataOffset + i.dataLength);
        }),
      ),
    );
    expect(wav.subarray(info.dataOffset, info.dataOffset + info.dataLength).equals(expected)).toBe(true);
    expect(info.dataOffset).toBe(44);
  });

  it("renders a long unbroken token in fixed-length parts", async () => {
    const { provider } = await open();
    const token = "Aaaah".repeat(300); // 1,500 characters, no space
    const wav = await provider.synthesize(say(token));
    expect(service.requests.filter((r) => r.url === "/tts").map((r) => (r.body as { text: string }).text.length)).toEqual([600, 600, 300]);
    expect(validateWav(wav).frames).toBeGreaterThan(0);
  });

  it("keeps the line's cache key and caches it as one line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mr-qwen-long-"));
    try {
      const { provider, service } = await open();
      const cache = new RenderCache({ dir, provider });
      const { renderCacheKey } = await import("./cache-key.js");
      const line = { id: "scenes[0].segments[3]", voiceId: "stub-f1", text: LONG };
      expect(cache.keyOf(say(LONG))).toBe(renderCacheKey(provider, say(LONG)));
      const [first] = await renderSegments([line], { cache });
      expect(first).toMatchObject({ id: line.id, status: "rendered" });
      const calls = service.requests.filter((r) => r.url === "/tts").length;
      expect(calls).toBe(splitSpeechText(LONG).length);
      const [second] = await renderSegments([line], { cache });
      expect(second).toMatchObject({ id: line.id, status: "cached" });
      expect(service.requests.filter((r) => r.url === "/tts").length).toBe(calls);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails the whole line, as billed, when any part fails or comes back unusable", async () => {
    const { provider, service } = await open();
    let n = 0;
    service.state.tts_handler = (_r, res) => (++n === 2 ? (res.writeHead(200, { "content-type": "audio/wav", "x-model-revision": "fake-1" }).end(Buffer.alloc(100, 1)), true) : false);
    const bad = await failure(provider.synthesize(say(LONG)));
    expect(bad).toMatchObject({ kind: "invalid_output", billed: true, retryable: true });
    expect(bad.message).toMatch(/part 2 of \d+ of a long line/);
    expect(n).toBe(2); // stopped at the bad part
    n = 0;
    service.state.tts_handler = (_r, res) => (++n === 2 ? (res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "busy" } })), true) : false);
    expect(await failure(provider.synthesize(say(LONG)))).toMatchObject({ kind: "unavailable", billed: true, retryable: true }); // part 1 was already rendered
  });
});

describe("speech service settings from the environment", () => {
  it("has defaults, and reads each variable", () => {
    expect(loadQwenConfig({})).toEqual({ baseUrl: "http://127.0.0.1:8765", token: undefined, timeoutMs: 600_000, msPerChar: 118, seed: 0 });
    expect(loadQwenConfig({ LOCAL_AUDIO_URL: "http://localhost:9000", LOCAL_AUDIO_TOKEN: ` ${TOKEN} `, LOCAL_AUDIO_TIMEOUT_MS: "90000", LOCAL_AUDIO_MS_PER_CHAR: "12.5", TTS_SEED: "7" })).toEqual({
      baseUrl: "http://localhost:9000",
      token: TOKEN,
      timeoutMs: 90_000,
      msPerChar: 12.5,
      seed: 7,
    });
  });

  it("names a malformed variable without echoing its value, and applies the address rules", () => {
    for (const env of [{ LOCAL_AUDIO_TIMEOUT_MS: "soon" }, { LOCAL_AUDIO_MS_PER_CHAR: "-1" }, { TTS_SEED: "1.5" }]) {
      expect(() => loadQwenConfig(env)).toThrow(/is malformed/);
    }
    expect(() => loadQwenConfig({ LOCAL_AUDIO_TIMEOUT_MS: "hunter2-secret" })).toThrow("invalid speech service configuration: LOCAL_AUDIO_TIMEOUT_MS is malformed");
    expect(() => loadQwenConfig({ LOCAL_AUDIO_URL: "http://example.com:8765", LOCAL_AUDIO_TOKEN: TOKEN })).toThrow(/must be https unless/);
    expect(() => loadQwenConfig({ LOCAL_AUDIO_URL: "https://abc.trycloudflare.com" })).toThrow(/needs LOCAL_AUDIO_TOKEN/);
    expect(loadQwenConfig({ LOCAL_AUDIO_URL: "https://abc.trycloudflare.com", LOCAL_AUDIO_TOKEN: TOKEN }).baseUrl).toBe("https://abc.trycloudflare.com");
  });
});

describe("with the render cache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-qwen-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("renders and caches audio from the service, and a second run needs no service call", async () => {
    const { provider, service } = await open();
    const cache = new RenderCache({ dir, provider });
    const lines = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, voiceId: i % 2 ? "stub-m1" : "stub-f1", text: `Line number ${i}.` }));
    const first = await renderSegments(lines, { cache });
    expect(first.map((o) => o.status)).toEqual(["rendered", "rendered", "rendered", "rendered"]);
    const calls = service.requests.filter((r) => r.url === "/tts").length;
    expect(calls).toBe(4);
    const second = await renderSegments(lines, { cache });
    expect(second.map((o) => o.status)).toEqual(["cached", "cached", "cached", "cached"]);
    expect(service.requests.filter((r) => r.url === "/tts").length).toBe(4);
  });

  it("does not cache anything if the service switches models, and keys differ per model revision", async () => {
    const { provider, service } = await open();
    const cache = new RenderCache({ dir, provider });
    service.state.revision = "fake-2";
    const out = await renderSegments([{ id: "a", voiceId: "stub-f1", text: "Hello there." }], { cache, delay: async () => undefined });
    expect(out[0]).toMatchObject({ status: "failed", attempts: 1, error: { kind: "unavailable", retryable: false } });
    expect(await cache.lookup(say("Hello there."))).toBeUndefined();

    const other = await connect({ baseUrl: service.url }); // a fresh connection sees the new revision
    expect(new RenderCache({ dir, provider: other }).keyOf(say("Hello there."))).not.toBe(cache.keyOf(say("Hello there.")));
    expect(validateWav(await other.synthesize(say("Hello there."))).frames).toBeGreaterThan(0);
  });

  it("reports a service that is down as a retryable failure, retried with backoff, and not billed", async () => {
    const { provider, service } = await open();
    const cache = new RenderCache({ dir, provider });
    await service.close();
    const waits: number[] = [];
    const out = await renderSegments([{ id: "a", voiceId: "stub-f1", text: "Hello there." }], { cache, delay: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(out[0]).toMatchObject({ status: "failed", attempts: 4, error: { kind: "unavailable", retryable: true } });
  });
});
