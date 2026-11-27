import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { requireClonable, transcriptHash, type ClonableCatalogue, type Voice, type VoiceCatalogue } from "@midnight-radio/core";
import { z } from "zod";
import { fetchWithTimeouts } from "./long-fetch.js";
import { rejected, SynthesisRequestSchema, TtsError, type ProviderIdentity, type SynthesisRequest, type SynthesizeOptions, type TtsProvider } from "./provider.js";
import { describeError } from "./redact.js";
import { WAV_SAMPLE_RATE } from "./wav.js";

/**
 * Speech from a Qwen3-TTS server that implements the speech service API (`docs/tts-service-api.md`):
 * `services/local-audio` on this machine, or a cloud GPU behind an https tunnel. The server is a
 * plain engine; every decision is made here. `connect` reads every voice's reference clip from
 * disk and checks it against the catalogue's hash, and checks that the server is ready, renders at
 * 24 kHz and runs exactly the model revision and weights the catalogue pins. Each line is then
 * sent with its voice's clip and transcript, and the revision that rendered it must still be the
 * one connected to, so audio from different weights can never be cached under the old identity.
 *
 * Plain http is accepted only on loopback; any other host needs https and a token, so neither the
 * token nor the clips cross a network unencrypted. Redirects are refused.
 */

export const LOCAL_AUDIO_API_VERSION = 1;
/** The language every line is spoken in. */
export const SPEECH_LANGUAGE = "English";
const MIN_TOKEN_CHARS = 16;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_WAV_BYTES = 64 * 1024 * 1024;
/**
 * Render time per character for the pre-render estimate: the median measured in the Task 5.1 spike
 * (Qwen3-TTS 1.7B Base, bf16, MLX, Apple M2). Override with LOCAL_AUDIO_MS_PER_CHAR on other machines.
 */
export const ASSUMED_MS_PER_CHAR = 118;

export interface QwenTtsOptions {
  /** The speech server: http on loopback, or https with a token. */
  baseUrl: string;
  /** Sent as a bearer token. Required for any server that is not on loopback. */
  token?: string | undefined;
  catalogue: VoiceCatalogue;
  /** The folder the catalogue's clip paths are relative to (`assets/voices`). */
  clipDir: string;
  /** Fixed seed sent with every render, so a render is repeatable. Part of the cache key. */
  seed?: number;
  /** Per-render timeout. */
  timeoutMs?: number;
  /** Estimated rendering time per character, for the pre-render report. */
  msPerChar?: number;
  maxWavBytes?: number;
  fetch?: typeof fetch;
}

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const HealthSchema = z.looseObject({
  apiVersion: z.number(),
  // weightsSha256 may be null while the model is still loading (then `ready` is false).
  tts: z.object({ model: z.string().min(1).max(200), revision: z.string().min(1).max(200), weightsSha256: sha.nullish().transform((v) => v ?? undefined), sampleRate: z.number(), ready: z.boolean() }).nullable(),
});

export const unavailable = (message: string, retryable = false, billed = false) => new TtsError("unavailable", message, billed, retryable);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Where speech may be sent: plain http only on loopback; any other host needs https and a token
 * of at least 16 characters. No credentials, query or fragment in the address.
 */
export function assertServiceUrl(raw: string, token: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw rejected("the speech service address (LOCAL_AUDIO_URL) is not a valid URL");
  }
  if (url.username || url.password) throw rejected("the speech service address must not contain credentials; use LOCAL_AUDIO_TOKEN");
  if (url.search || url.hash) throw rejected("the speech service address must not have a query or fragment");
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol === "http:" && loopback) return url;
  if (url.protocol !== "https:") throw rejected("the speech service address must be https unless it is on 127.0.0.1 or localhost");
  if (!token || token.length < MIN_TOKEN_CHARS) throw rejected(`a speech service that is not on this machine needs LOCAL_AUDIO_TOKEN (at least ${MIN_TOKEN_CHARS} characters)`);
  return url;
}

/** Read every voice's reference clip and check it against the catalogue's hash. */
async function loadClips(clonable: ClonableCatalogue, clipDir: string): Promise<Map<string, { audio: string; text: string }>> {
  const root = resolve(clipDir);
  const clips = new Map<string, { audio: string; text: string }>();
  for (const v of clonable.voices) {
    const path = resolve(root, v.clip.file);
    if (!path.startsWith(root + sep)) throw rejected(`the clip for voice "${v.id}" is outside the catalogue folder`);
    const bytes = await readFile(path).catch(() => {
      throw rejected(`the reference clip for voice "${v.id}" is missing (${v.clip.file})`);
    });
    if (createHash("sha256").update(bytes).digest("hex") !== v.clip.sha256) throw rejected(`the reference clip for voice "${v.id}" does not match the catalogue's hash`);
    clips.set(v.id, { audio: bytes.toString("base64"), text: v.clip.transcript });
  }
  return clips;
}

export class QwenTtsProvider implements TtsProvider {
  readonly identity: ProviderIdentity;
  private readonly base: string;
  private readonly clonable: ClonableCatalogue;
  private readonly fingerprints = new Map<string, string>();
  private readonly seed: number;
  private readonly timeoutMs: number;
  private readonly msPerChar: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string | undefined;
  private readonly clips: Map<string, { audio: string; text: string }>;

  private constructor(opts: QwenTtsOptions, base: string, clonable: ClonableCatalogue, clips: Map<string, { audio: string; text: string }>, model: string, revision: string, weightsSha256: string | undefined) {
    this.base = base;
    this.clips = clips;
    this.clonable = clonable;
    this.token = opts.token;
    this.seed = opts.seed ?? 0;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.msPerChar = opts.msPerChar ?? ASSUMED_MS_PER_CHAR;
    this.maxBytes = opts.maxWavBytes ?? DEFAULT_MAX_WAV_BYTES;
    this.fetchImpl = opts.fetch ?? fetchWithTimeouts(this.timeoutMs); // a long line can take minutes to render
    // The weights hash is part of the identity, so audio from different weights never shares a cache entry.
    this.identity = {
      provider: "qwen3-tts",
      model,
      revision,
      settings: { seed: this.seed, apiVersion: LOCAL_AUDIO_API_VERSION, sampleRate: WAV_SAMPLE_RATE, ...(weightsSha256 ? { weightsSha256 } : {}) },
    };
    for (const v of clonable.voices) this.fingerprints.set(v.id, `clip:${v.clip.sha256}:${transcriptHash(v.clip.transcript)}`);
  }

  /** Connect to the service and verify it against the catalogue. Throws TtsError if it cannot be used. */
  static async connect(opts: QwenTtsOptions): Promise<QwenTtsProvider> {
    const url = assertServiceUrl(opts.baseUrl, opts.token);
    let clonable: ClonableCatalogue;
    try {
      clonable = requireClonable(opts.catalogue);
    } catch (err) {
      throw rejected(`the voice catalogue cannot be used for cloning: ${describeError(err).message}`);
    }
    const clips = await loadClips(clonable, opts.clipDir);
    const fetchImpl = opts.fetch ?? fetch;
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;

    let res: Response;
    try {
      res = await fetchImpl(`${base}/health`, { headers: authHeaders(opts.token), redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw describeFetchFailure(err, undefined, false);
    }
    if (res.status === 401 || res.status === 403) throw rejected("the speech service refused the access token (check LOCAL_AUDIO_TOKEN)");
    if (!res.ok) throw unavailable(`the speech service answered /health with HTTP ${res.status}`, res.status >= 500);
    const health = HealthSchema.safeParse(await res.json().catch(() => undefined));
    if (!health.success) throw unavailable("the speech service gave an unreadable /health answer (is this a speech server?)");
    const h = health.data;
    if (h.apiVersion !== LOCAL_AUDIO_API_VERSION) throw unavailable(`the speech service speaks API version ${h.apiVersion}, expected ${LOCAL_AUDIO_API_VERSION}`);
    if (!h.tts || !h.tts.ready) throw unavailable("the speech service has no speech model ready yet", true);
    if (h.tts.sampleRate !== WAV_SAMPLE_RATE) throw unavailable(`the speech model renders at ${h.tts.sampleRate} Hz, expected ${WAV_SAMPLE_RATE}`);

    const pinned = clonable.models?.find((m) => m.role === "voice-clone");
    // The name carries the build and precision (e.g. "Qwen3-TTS-12Hz-1.7B-Base (float32)"), so it is pinned too.
    if (pinned && pinned.name !== h.tts.model) {
      throw unavailable(`the speech service runs "${h.tts.model}", not the "${pinned.name}" the catalogue pins`);
    }
    if (pinned && pinned.revision !== h.tts.revision) {
      throw unavailable(`the speech model revision "${h.tts.revision}" is not the one the catalogue pins ("${pinned.revision}")`);
    }
    if (pinned?.weightsSha256 && pinned.weightsSha256 !== h.tts.weightsSha256) {
      throw unavailable(`the speech model weights (${h.tts.weightsSha256 ? h.tts.weightsSha256.slice(0, 12) : "not reported"}) are not the ones the catalogue pins (${pinned.weightsSha256.slice(0, 12)})`);
    }
    return new QwenTtsProvider(opts, base, clonable, clips, h.tts.model, h.tts.revision, h.tts.weightsSha256);
  }

  async voices(): Promise<Voice[]> {
    return [...this.clonable.voices];
  }

  voiceFingerprint(voiceId: string): string {
    const fingerprint = this.fingerprints.get(voiceId);
    if (!fingerprint) throw rejected(`unknown voice "${voiceId}"`);
    return fingerprint;
  }

  estimateRenderMs(chars: number): number {
    return Math.ceil(chars * this.msPerChar);
  }

  async synthesize(request: SynthesisRequest, opts: SynthesizeOptions = {}): Promise<Buffer> {
    if (opts.signal?.aborted) throw new TtsError("aborted", "render aborted", false, false);
    const parsed = SynthesisRequestSchema.safeParse(request);
    if (!parsed.success) throw rejected(`invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "request"} ${i.message}`).join("; ")}`);
    const req = parsed.data;
    this.voiceFingerprint(req.voiceId); // unknown voice
    const clip = this.clips.get(req.voiceId)!;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(this.token) },
        // Delivery hints are not sent: every line clones its voice's clip as it is (Task 5.1, option a).
        body: JSON.stringify({ text: req.text, language: SPEECH_LANGUAGE, seed: this.seed, reference: { audio: clip.audio, text: clip.text } }),
        redirect: "error",
        signal,
      });
    } catch (err) {
      throw describeFetchFailure(err, opts.signal, true);
    }

    if (!res.ok) throw await failureFromResponse(res);
    if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("audio/wav")) {
      await res.body?.cancel().catch(() => undefined);
      throw new TtsError("invalid_output", "the speech service did not return a WAV file", true, true);
    }
    const revision = res.headers.get("x-model-revision");
    if (revision !== this.identity.revision) {
      await res.body?.cancel().catch(() => undefined);
      throw new TtsError("unavailable", `the speech model changed while connected (now "${revision ?? "unknown"}"); reconnect to the service`, true, false);
    }
    try {
      return await readLimited(res, this.maxBytes, signal);
    } catch (err) {
      if (err instanceof TtsError) throw err;
      throw describeFetchFailure(err, opts.signal, true);
    }
  }
}

export const authHeaders = (token: string | undefined): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** Map a failed request to a TtsError. Messages hold fixed text and codes only, never the request or the token. */
export function describeFetchFailure(err: unknown, callerSignal: AbortSignal | undefined, requestSent: boolean): TtsError {
  if (callerSignal?.aborted) return new TtsError("aborted", "render aborted", requestSent, false); // the service may still be rendering
  const name = (err as Error | undefined)?.name;
  if (name === "TimeoutError") return new TtsError("timeout", "the speech service did not answer in time", true, true);
  const code = ((err as { cause?: { code?: string } } | undefined)?.cause?.code ?? "") as string;
  if (code === "ECONNREFUSED") return unavailable("the speech service is not running", true, false);
  return new TtsError("unavailable", "the connection to the speech service failed", requestSent, true);
}

export async function failureFromResponse(res: Response): Promise<TtsError> {
  const body = (await res.json().catch(() => undefined)) as { error?: { code?: unknown } } | undefined;
  const raw = typeof body?.error?.code === "string" ? body.error.code : "";
  const code = /^[a-z_]{1,40}$/.test(raw) ? raw : "unknown";
  const s = res.status;
  if (s === 401 || s === 403) return rejected("the speech service refused the access token (set LOCAL_AUDIO_TOKEN)");
  if (s === 400 || s === 404 || s === 411 || s === 413 || s === 415) return rejected(`the speech service rejected the request (HTTP ${s}, ${code})`);
  if (s === 503) return unavailable(`the speech service is busy or not ready (${code})`, true);
  return new TtsError("service_error", `the speech service failed (HTTP ${s}, ${code})`, true, true);
}

export async function readLimited(res: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new TtsError("invalid_output", "the audio from the speech service is too large", true, true);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw signal.reason;
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new TtsError("invalid_output", "the audio from the speech service is too large", true, true);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const ConfigSchema = z.object({
  LOCAL_AUDIO_URL: z.string().optional().transform((s) => s?.trim() || "http://127.0.0.1:8765"),
  LOCAL_AUDIO_TOKEN: z.string().optional().transform((s) => s?.trim() || undefined),
  LOCAL_AUDIO_TIMEOUT_MS: z.string().optional().transform((s) => s?.trim() ?? "").pipe(z.union([z.literal("").transform(() => DEFAULT_TIMEOUT_MS), z.string().regex(/^\d+$/).transform(Number).refine((n) => n >= 1_000 && n <= 3_600_000)])),
  LOCAL_AUDIO_MS_PER_CHAR: z.string().optional().transform((s) => s?.trim() ?? "").pipe(z.union([z.literal("").transform(() => ASSUMED_MS_PER_CHAR), z.string().regex(/^\d+(\.\d+)?$/).transform(Number).refine((n) => n > 0 && n <= 10_000)])),
  TTS_SEED: z.string().optional().transform((s) => s?.trim() ?? "").pipe(z.union([z.literal("").transform(() => 0), z.string().regex(/^\d+$/).transform(Number).refine((n) => Number.isSafeInteger(n) && n <= 2 ** 31 - 1)])),
});

export interface QwenEnvConfig {
  baseUrl: string;
  token: string | undefined;
  timeoutMs: number;
  msPerChar: number;
  seed: number;
}

/** Read the speech service settings. Errors name the variable but never echo its value (the token included). */
export function loadQwenConfig(env: Record<string, string | undefined> = process.env): QwenEnvConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid speech service configuration: ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")} is malformed`);
  const c = parsed.data;
  assertServiceUrl(c.LOCAL_AUDIO_URL, c.LOCAL_AUDIO_TOKEN);
  return { baseUrl: c.LOCAL_AUDIO_URL, token: c.LOCAL_AUDIO_TOKEN, timeoutMs: c.LOCAL_AUDIO_TIMEOUT_MS, msPerChar: c.LOCAL_AUDIO_MS_PER_CHAR, seed: c.TTS_SEED };
}
