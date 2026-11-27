import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeWav, SfxClient } from "@midnight-radio/tts";

/**
 * An offline sound-effect server for tests, at the fetch level: `/health` and `POST /sfx` as in
 * `docs/sfx-service-api.md`, with the optional idempotency extension. It never touches the
 * network. One-off cues get a sharp decaying burst; beds get steady noise. Faults are injected per
 * request through `fault`.
 */

const RATE = 48_000;

export interface FakeSfxServer {
  fetch: typeof fetch;
  /** Renders actually performed (replays excluded). */
  renders: string[];
  /** Every POST /sfx with its key. */
  requests: { key: string; prompt: string }[];
  replays: number;
  /** Return "drop-after-render" to render and lose the answer, "drop" to fail before rendering, "500" for a server error. */
  fault: (req: { key: string; prompt: string; n: number }) => "drop" | "drop-after-render" | "500" | null;
  /** Called before each render; can await to hold a render open. */
  onRender?: (prompt: string) => Promise<void> | void;
  connect: () => Promise<SfxClient>;
}

function noiseFor(prompt: string, seed: number, seconds: number, loopable: boolean): Int16Array {
  let s = (createHash("sha256").update(`${prompt}${seed}`).digest().readUInt32LE(0) & 0x7fffffff) || 1;
  const rnd = () => ((s = (s * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  return Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => {
    const t = i / RATE;
    const env = loopable ? 0.15 : 0.6 * Math.exp(-t * 3);
    return Math.round(env * rnd() * 32767);
  });
}

export function fakeSfxServer(opts: { idempotency?: boolean; model?: string; loopable?: (prompt: string) => boolean } = {}): FakeSfxServer {
  const done = new Map<string, Buffer>();
  const server: FakeSfxServer = {
    renders: [],
    requests: [],
    replays: 0,
    fault: () => null,
    fetch: (async (url: string, init?: RequestInit) => {
      const health = { apiVersion: 1, sfx: { model: opts.model ?? "test-sfx", revision: "rev-1", weightsSha256: null, license: "CC0-1.0", sampleRate: RATE, ready: true, ...(opts.idempotency === false ? {} : { idempotency: true }) } };
      if (url.endsWith("/health")) return new Response(JSON.stringify(health), { status: 200, headers: { "content-type": "application/json" } });
      const headers = init!.headers as Record<string, string>;
      const key = headers["idempotency-key"]!;
      const body = JSON.parse(String(init!.body)) as { prompt: string; durationSec: number; seed: number };
      server.requests.push({ key, prompt: body.prompt });
      const n = server.requests.filter((r) => r.key === key).length;
      const fault = server.fault({ key, prompt: body.prompt, n });
      if (fault === "drop") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      if (fault === "500") return new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), { status: 500 });
      const wav = (b: Buffer, replay: boolean) => new Response(new Uint8Array(b), { status: 200, headers: { "content-type": "audio/wav", "x-model-revision": "rev-1", ...(replay ? { "x-idempotent-replay": "true" } : {}) } });
      if (opts.idempotency !== false && done.has(key)) {
        server.replays++;
        return wav(done.get(key)!, true);
      }
      await server.onRender?.(body.prompt);
      const bytes = encodeWav(noiseFor(body.prompt, body.seed, body.durationSec, (opts.loopable ?? ((p) => /rain|wind|bed/i.test(p)))(body.prompt)), RATE);
      server.renders.push(key);
      if (opts.idempotency !== false) done.set(key, bytes);
      if (fault === "drop-after-render") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return wav(bytes, false);
    }) as unknown as typeof fetch,
    connect: () => SfxClient.connect({ baseUrl: "http://127.0.0.1:9", fetch: server.fetch, sleep: async () => undefined }),
  };
  return server;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A tiny committed library in `dir`: prompts for the given cues and one theme (a 3 s tone). */
export async function writeSourceLibrary(dir: string, cues: { id: string; prompt: string; durationSec: number; seed: number; loopable: boolean }[]): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  const R = 24_000;
  const theme = encodeWav(
    Int16Array.from({ length: 3 * R }, (_, i) => {
      const fade = Math.min(1, i / 2400, (3 * R - 1 - i) / 2400);
      return Math.round(0.5 * fade * 32767 * Math.sin((2 * Math.PI * 220 * i) / R));
    }),
    R,
  );
  await writeFile(join(dir, "music/theme_test.wav"), theme);
  const entry = { id: "theme_test", kind: "music", title: "Test theme", path: "music/theme_test.wav", sha256: sha(theme), durationMs: 3000, loopable: false, peakDb: -6, tags: ["music", "theme"], source: { type: "project", author: "Tests", licence: "CC0-1.0" } };
  await writeFile(join(dir, "index.json"), JSON.stringify({ version: 1, id: "midnight-radio-sfx-test", entries: [entry], musicCues: { theme: "theme_test", sting: "theme_test", transition: "theme_test" } }));
  await writeFile(join(dir, "prompts.json"), JSON.stringify({ version: 1, cues }));
}
