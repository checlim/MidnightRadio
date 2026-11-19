import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSUMED_MS_PER_CHAR, QwenTtsProvider, assertLoopbackUrl, loadQwenConfig, type QwenTtsOptions } from "./qwen-provider.js";
import { TtsError } from "./provider.js";
import { RenderCache } from "./render-cache.js";
import { renderSegments } from "./segments.js";
import { clonableStubCatalogue, CLIP_TRANSCRIPT } from "./test-support/clonable-catalogue.js";
import { closedPort, startFakeService, type FakeService, type FakeState } from "./test-support/fake-audio-service.js";
import { validateWav } from "./wav.js";

const TOKEN = "service-token-0123456789abcdef";
const catalogue = clonableStubCatalogue();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let service: FakeService;
const open = async (state: Partial<FakeState> = {}, opts: Partial<QwenTtsOptions> = {}) => {
  service = await startFakeService(catalogue, state);
  return { provider: await QwenTtsProvider.connect({ baseUrl: service.url, catalogue, ...opts }), service };
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
    ["an answer from some other service", { service: "something-else" }, /unreadable/, false],
    ["a different API version", { apiVersion: 2 }, /API version 2, expected 1/, false],
    ["no speech model", { tts: null }, /no speech model ready/, true],
    ["a speech model that is still loading", { tts: { sampleRate: 24_000, ready: false } }, /no speech model ready/, true],
    ["a speech model at the wrong rate", { tts: { sampleRate: 44_100, ready: true } }, /44100 Hz/, false],
    ["a voice missing from the service", { voices: {} }, /does not know voice "stub-announcer"/, false],
    ["a reference clip that differs", { voices: Object.fromEntries(catalogue.voices.map((v) => [v.id, { clipSha256: v.id === "stub-f1" ? sha("other clip") : v.clip.sha256, transcriptSha256: sha(CLIP_TRANSCRIPT) }])) }, /reference clip for voice "stub-f1" differs/, false],
    ["a transcript that differs", { voices: Object.fromEntries(catalogue.voices.map((v) => [v.id, { clipSha256: v.clip.sha256, transcriptSha256: v.id === "stub-m1" ? sha("other words") : sha(CLIP_TRANSCRIPT) }])) }, /transcript for voice "stub-m1" differs/, false],
    ["an error page", { healthStatus: 500, healthBody: "oops" }, /HTTP 500/, true],
    ["an unreadable answer", { healthBody: "not json" }, /unreadable/, false],
  ];
  it.each(refusals)("refuses %s", async (_label, state, message, retryable) => {
    service = await startFakeService(catalogue, state);
    const e = await failure(QwenTtsProvider.connect({ baseUrl: service.url, catalogue }));
    expect(e).toMatchObject({ kind: "unavailable", billed: false, retryable });
    expect(e.message).toMatch(message);
  });

  it("refuses a model revision other than the one the catalogue pins, and accepts the pinned one", async () => {
    const pinned = clonableStubCatalogue({ models: [{ role: "voice-clone", name: "Base", revision: "rev-A" }] });
    service = await startFakeService(pinned, { revision: "rev-B" });
    const e = await failure(QwenTtsProvider.connect({ baseUrl: service.url, catalogue: pinned }));
    expect(e.message).toMatch(/revision "rev-B" is not the one the catalogue pins \("rev-A"\)/);
    service.state.revision = "rev-A";
    expect((await QwenTtsProvider.connect({ baseUrl: service.url, catalogue: pinned })).identity.revision).toBe("rev-A");
  });

  it("pins the weights: refuses different or unreported weights when the catalogue pins a hash, and puts the hash in the identity", async () => {
    const weights = sha("the pinned weights");
    const pinned = clonableStubCatalogue({ models: [{ role: "voice-clone", name: "Base", revision: "fake-1", weightsSha256: weights }] });
    service = await startFakeService(pinned, { tts: { sampleRate: 24_000, ready: true, weightsSha256: sha("other weights") } });
    expect((await failure(QwenTtsProvider.connect({ baseUrl: service.url, catalogue: pinned }))).message).toMatch(/weights \([0-9a-f]{12}\) are not the ones the catalogue pins/);
    service.state.tts = { sampleRate: 24_000, ready: true };
    expect((await failure(QwenTtsProvider.connect({ baseUrl: service.url, catalogue: pinned }))).message).toMatch(/weights \(not reported\)/);
    service.state.tts = { sampleRate: 24_000, ready: true, weightsSha256: weights };
    const provider = await QwenTtsProvider.connect({ baseUrl: service.url, catalogue: pinned });
    expect(provider.identity.settings).toMatchObject({ weightsSha256: weights });
  });

  it("gives renders from different weights different cache keys", async () => {
    service = await startFakeService(catalogue, { tts: { sampleRate: 24_000, ready: true, weightsSha256: sha("weights A") } });
    const a = await QwenTtsProvider.connect({ baseUrl: service.url, catalogue });
    service.state.tts = { sampleRate: 24_000, ready: true, weightsSha256: sha("weights B") };
    const b = await QwenTtsProvider.connect({ baseUrl: service.url, catalogue });
    const { renderCacheKey } = await import("./cache-key.js");
    expect(renderCacheKey(a, say("Hello."))).not.toBe(renderCacheKey(b, say("Hello.")));
  });

  it("refuses a token the service does not accept, and a catalogue that cannot be cloned from", async () => {
    service = await startFakeService(catalogue, { token: TOKEN });
    const e = await failure(QwenTtsProvider.connect({ baseUrl: service.url, catalogue, token: "wrong-token-value-123456" }));
    expect(e).toMatchObject({ kind: "rejected", retryable: false });
    expect(e.message).toMatch(/LOCAL_AUDIO_TOKEN/);
    expect(e.message).not.toContain("wrong-token-value");
    expect(await failure(QwenTtsProvider.connect({ baseUrl: service.url, catalogue: { ...catalogue, voices: catalogue.voices.map(({ clip: _c, ...v }) => v) } as never, token: TOKEN }))).toMatchObject({ kind: "rejected" });
  });

  it("reports a service that is not running as retryable, and not as billed", async () => {
    const port = await closedPort();
    const e = await failure(QwenTtsProvider.connect({ baseUrl: `http://127.0.0.1:${port}`, catalogue }));
    expect(e).toMatchObject({ kind: "unavailable", billed: false, retryable: true });
    expect(e.message).toMatch(/not running/);
  });
});

describe("loopback only", () => {
  it.each(["http://127.0.0.1:8765", "http://localhost:8765", "http://127.0.0.1"])("accepts %s", (url) => {
    expect(() => assertLoopbackUrl(url)).not.toThrow();
  });
  it.each(["http://example.com:8765", "http://192.168.1.20:8765", "https://127.0.0.1:8765", "http://user:pass@127.0.0.1:8765", "http://0.0.0.0:8765", "ftp://127.0.0.1", "not a url", ""])("refuses %s", async (url) => {
    expect(() => assertLoopbackUrl(url)).toThrow(/not a valid URL|http on 127\.0\.0\.1 or localhost/);
    expect(await failure(QwenTtsProvider.connect({ baseUrl: url, catalogue, token: TOKEN }))).toMatchObject({ kind: "rejected" });
  });
});

describe("rendering", () => {
  it("returns the service's WAV, sending exactly the voice, the text as given, the delivery and the seed", async () => {
    const { provider } = await open({}, { seed: 42 });
    const wav = await provider.synthesize({ voiceId: "stub-f1", text: "  “Welcome,” he said.\n", delivery: "sinister" });
    expect(validateWav(wav).frames).toBeGreaterThan(0);
    const sent = service.requests.at(-1)!;
    expect(sent.method).toBe("POST");
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.body).toEqual({ voiceId: "stub-f1", text: "  “Welcome,” he said.\n", delivery: "sinister", seed: 42 });
    expect(provider.identity.settings).toMatchObject({ seed: 42 });
    await provider.synthesize(say("No hint."));
    expect(service.requests.at(-1)!.body).toEqual({ voiceId: "stub-f1", text: "No hint.", seed: 42 });
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
      [404, "unknown_voice", "rejected", false, false],
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
      expect(e.message).toBe("the local audio service failed (HTTP 500, unknown)");
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

describe("local audio settings from the environment", () => {
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

  it("names a malformed variable without echoing its value, and refuses a non-loopback address", () => {
    for (const env of [{ LOCAL_AUDIO_TIMEOUT_MS: "soon" }, { LOCAL_AUDIO_MS_PER_CHAR: "-1" }, { TTS_SEED: "1.5" }]) {
      expect(() => loadQwenConfig(env)).toThrow(/is malformed/);
    }
    expect(() => loadQwenConfig({ LOCAL_AUDIO_TIMEOUT_MS: "hunter2-secret" })).toThrow("invalid local audio configuration: LOCAL_AUDIO_TIMEOUT_MS is malformed");
    expect(() => loadQwenConfig({ LOCAL_AUDIO_URL: "http://example.com:8765", LOCAL_AUDIO_TOKEN: TOKEN })).toThrow(/127\.0\.0\.1 or localhost/);
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

    const other = await QwenTtsProvider.connect({ baseUrl: service.url, catalogue }); // a fresh connection sees the new revision
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
