import { describe, expect, it } from "vitest";
import { assertSfxServiceUrl, loadSfxConfig, SfxClient, SfxError } from "./sfx-client.js";
import { encodeWav } from "./wav.js";

const RATE = 48_000;
const KEY = "a".repeat(64);
const TOKEN = "t0ken-for-the-sfx-server";
const health = (over: Record<string, unknown> = {}) => ({ apiVersion: 1, sfx: { model: "stub-sfx", revision: "r1", weightsSha256: null, license: "CC0-1.0", sampleRate: RATE, ready: true, idempotency: true, ...over } });
const tone = (seconds: number) => encodeWav(Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.round(8000 * Math.sin(i / 10))), RATE);
const wav = (bytes: Buffer, headers: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "audio/wav", "x-model-revision": "r1", ...headers } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake server: /health answers `h`, POST /sfx answers from the queue. Records every request. */
function fake(h: unknown, answers: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/health")) return json(200, h);
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const noSleep = async () => undefined;
const req = { prompt: "A match strikes.", durationSec: 3, seed: 7 };

describe("SfxClient", () => {
  it("connects, pins the model, sends the key and token, and returns a checked take", async () => {
    const { f, calls } = fake(health(), [() => wav(tone(3))]);
    const c = await SfxClient.connect({ baseUrl: "https://sfx.example", token: TOKEN, fetch: f, sleep: noSleep });
    expect(c.model).toEqual({ model: "stub-sfx", revision: "r1", weightsSha256: null, license: "CC0-1.0", sampleRate: RATE, idempotency: true });
    const bytes = await c.render(req, { idempotencyKey: KEY });
    expect(bytes.length).toBeGreaterThan(1000);
    const post = calls.find((x) => x.url.endsWith("/sfx"))!;
    expect(post.headers["idempotency-key"]).toBe(KEY);
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.body).toEqual(req);
  });

  it("reports a server without idempotency so the caller counts uncertain requests", async () => {
    const { f } = fake(health({ idempotency: undefined }), []);
    expect((await SfxClient.connect({ baseUrl: "http://127.0.0.1:9", fetch: f })).model.idempotency).toBe(false);
  });

  it("waits on 409 in_progress with the same key, then takes the replay", async () => {
    const { f, calls } = fake(health(), [() => json(409, { error: { code: "in_progress" } }, { "retry-after": "2" }), () => wav(tone(3), { "x-idempotent-replay": "true" })]);
    const waits: number[] = [];
    const c = await SfxClient.connect({ baseUrl: "http://127.0.0.1:9", fetch: f, sleep: async (ms) => void waits.push(ms) });
    await c.render(req, { idempotencyKey: KEY });
    expect(waits).toEqual([2000]);
    expect(calls.filter((x) => x.url.endsWith("/sfx")).map((x) => x.headers["idempotency-key"])).toEqual([KEY, KEY]);
  });

  it("classifies failures: dropped connections are uncertain, server errors retryable, a bad token or key mismatch fatal", async () => {
    const dropped = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const cases: [() => Response | Promise<Response>, SfxError["kind"]][] = [
      [() => Promise.reject(dropped), "uncertain"],
      [() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), "uncertain"],
      [() => Promise.reject(Object.assign(new TypeError("x"), { cause: { code: "ECONNREFUSED" } })), "retryable"],
      [() => json(500, { error: { code: "internal" } }), "retryable"],
      [() => json(401, { error: { code: "unauthorized" } }), "fatal"],
      [() => json(422, { error: { code: "idempotency_mismatch" } }), "fatal"],
      [() => json(400, { error: { code: "bad_request" } }), "fatal"],
      [() => wav(tone(3), { "x-model-revision": "r2" }), "fatal"],
      [() => wav(tone(3.5)), "retryable"],
      [() => wav(encodeWav(new Int16Array(RATE * 3), RATE)), "retryable"],
      [() => new Response("x", { status: 200, headers: { "content-type": "text/plain", "x-model-revision": "r1" } }), "retryable"],
    ];
    for (const [answer, kind] of cases) {
      const { f } = fake(health(), [answer]);
      const c = await SfxClient.connect({ baseUrl: "http://127.0.0.1:9", fetch: f, sleep: noSleep });
      const err = await c.render(req, { idempotencyKey: KEY }).catch((e: unknown) => e);
      expect(err, String(answer)).toBeInstanceOf(SfxError);
      expect((err as SfxError).kind, String(answer)).toBe(kind);
    }
  });

  it("gives up waiting on a busy server after the bounded number of waits", async () => {
    const { f, calls } = fake(health(), Array.from({ length: 5 }, () => () => json(503, { error: { code: "busy" } })));
    const c = await SfxClient.connect({ baseUrl: "http://127.0.0.1:9", fetch: f, sleep: noSleep, maxBusyWaits: 3 });
    await expect(c.render(req, { idempotencyKey: KEY })).rejects.toMatchObject({ kind: "retryable" });
    expect(calls.filter((x) => x.url.endsWith("/sfx"))).toHaveLength(4);
  });

  it("stops when cancelled, and refuses a bad key", async () => {
    const { f } = fake(health(), [() => json(503, { error: { code: "busy" } })]);
    const ac = new AbortController();
    const c = await SfxClient.connect({ baseUrl: "http://127.0.0.1:9", fetch: f, sleep: async () => ac.abort() });
    await expect(c.render(req, { idempotencyKey: KEY, signal: ac.signal })).rejects.toMatchObject({ kind: "aborted" });
    await expect(c.render(req, { idempotencyKey: "nope" })).rejects.toMatchObject({ kind: "fatal" });
  });

  it("refuses a server that is not ready, has no model, speaks another version, or changes model", async () => {
    for (const [h, kind] of [
      [health({ ready: false }), "retryable"],
      [{ apiVersion: 1, sfx: null }, "fatal"],
      [{ ...health(), apiVersion: 2 }, "fatal"],
    ] as const) {
      const { f } = fake(h, []);
      await expect(SfxClient.connect({ baseUrl: "http://127.0.0.1:9", fetch: f })).rejects.toMatchObject({ kind });
    }
    let rev = "r1";
    const f = (async () => json(200, health({ revision: rev }))) as unknown as typeof fetch;
    const c = await SfxClient.connect({ baseUrl: "http://127.0.0.1:9", fetch: f });
    rev = "r2";
    await expect(c.recheck()).rejects.toMatchObject({ kind: "fatal" });
  });

  it("enforces https and a token off loopback, and never echoes the token", () => {
    expect(() => assertSfxServiceUrl("http://sfx.example", TOKEN)).toThrow(/https/);
    expect(() => assertSfxServiceUrl("https://sfx.example", undefined)).toThrow(/SFX_SERVICE_TOKEN/);
    expect(() => assertSfxServiceUrl("https://u:p@sfx.example", TOKEN)).toThrow(/credentials/);
    expect(assertSfxServiceUrl("http://localhost:8765", undefined).host).toBe("localhost:8765");
    expect(loadSfxConfig({})).toBeNull();
    expect(loadSfxConfig({ SFX_SERVICE_URL: "https://sfx.example", SFX_SERVICE_TOKEN: TOKEN })).toMatchObject({ baseUrl: "https://sfx.example", timeoutMs: 900_000 });
    const err = (() => {
      try {
        loadSfxConfig({ SFX_SERVICE_URL: "https://sfx.example", SFX_SERVICE_TOKEN: "short", SFX_SERVICE_TIMEOUT_MS: "1" });
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    expect(err).toMatch(/SFX_SERVICE_TIMEOUT_MS/);
    expect(err).not.toContain("short");
  });
});
