import { requireClonable, transcriptHash, type ClonableCatalogue, type Voice, type VoiceCatalogue } from "@midnight-radio/core";
import { z } from "zod";
import { rejected, SynthesisRequestSchema, TtsError, type ProviderIdentity, type SynthesisRequest, type SynthesizeOptions, type TtsProvider } from "./provider.js";
import { describeError } from "./redact.js";
import { WAV_SAMPLE_RATE } from "./wav.js";

/**
 * Speech from the local audio service (`services/local-audio`), which runs Qwen3-TTS on this
 * machine. The provider never calls a cloud service, and it refuses to talk to anything that is
 * not on the loopback interface, so the access token cannot be sent elsewhere.
 *
 * `connect` checks the service against the pinned catalogue before any audio is accepted: same
 * API version, the speech model ready, the model revision the catalogue pins, and every voice's
 * reference clip and transcript matching by hash. Each render then checks that the revision that
 * produced the audio is still the one connected to, so audio from different weights can never be
 * cached under the old identity.
 */

export const LOCAL_AUDIO_SERVICE = "midnight-radio-local-audio";
export const LOCAL_AUDIO_API_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_WAV_BYTES = 64 * 1024 * 1024;
/** Assumed until the Task 5.1 spike measures this machine: about 1 s of rendering per 15 characters. */
export const ASSUMED_MS_PER_CHAR = 70;

export interface QwenTtsOptions {
  /** Where the service listens. Must be a loopback address. */
  baseUrl: string;
  /** Sent as a bearer token if the service was started with LOCAL_AUDIO_TOKEN. */
  token?: string | undefined;
  catalogue: VoiceCatalogue;
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
  service: z.literal(LOCAL_AUDIO_SERVICE),
  apiVersion: z.number(),
  backend: z.string(),
  tts: z.object({ model: z.string(), revision: z.string(), sampleRate: z.number(), ready: z.boolean() }).nullable(),
  voices: z.record(z.string(), z.object({ clipSha256: sha, transcriptSha256: sha })),
});

const unavailable = (message: string, retryable = false, billed = false) => new TtsError("unavailable", message, billed, retryable);

/** Loopback only: the token must not be sent to any other host. */
export function assertLoopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw rejected("the local audio service address is not a valid URL");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw rejected("the local audio service address must be http on 127.0.0.1 or localhost, with no credentials");
  }
  return url;
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

  private constructor(opts: QwenTtsOptions, base: string, clonable: ClonableCatalogue, model: string, revision: string) {
    this.base = base;
    this.clonable = clonable;
    this.token = opts.token;
    this.seed = opts.seed ?? 0;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.msPerChar = opts.msPerChar ?? ASSUMED_MS_PER_CHAR;
    this.maxBytes = opts.maxWavBytes ?? DEFAULT_MAX_WAV_BYTES;
    this.fetchImpl = opts.fetch ?? fetch;
    this.identity = { provider: "qwen3-tts", model, revision, settings: { seed: this.seed, apiVersion: LOCAL_AUDIO_API_VERSION, sampleRate: WAV_SAMPLE_RATE } };
    for (const v of clonable.voices) this.fingerprints.set(v.id, `clip:${v.clip.sha256}:${transcriptHash(v.clip.transcript)}`);
  }

  /** Connect to the service and verify it against the catalogue. Throws TtsError if it cannot be used. */
  static async connect(opts: QwenTtsOptions): Promise<QwenTtsProvider> {
    const url = assertLoopbackUrl(opts.baseUrl);
    let clonable: ClonableCatalogue;
    try {
      clonable = requireClonable(opts.catalogue);
    } catch (err) {
      throw rejected(`the voice catalogue cannot be used for cloning: ${describeError(err).message}`);
    }
    const fetchImpl = opts.fetch ?? fetch;
    const base = url.origin;

    let res: Response;
    try {
      res = await fetchImpl(`${base}/health`, { headers: authHeaders(opts.token), redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw describeFetchFailure(err, undefined, false);
    }
    if (res.status === 401 || res.status === 403) throw rejected("the local audio service refused the access token (set LOCAL_AUDIO_TOKEN)");
    if (!res.ok) throw unavailable(`the local audio service answered /health with HTTP ${res.status}`, res.status >= 500);
    const health = HealthSchema.safeParse(await res.json().catch(() => undefined));
    if (!health.success) throw unavailable("the local audio service gave an unreadable /health answer");
    const h = health.data;
    if (h.apiVersion !== LOCAL_AUDIO_API_VERSION) throw unavailable(`the local audio service speaks API version ${h.apiVersion}, expected ${LOCAL_AUDIO_API_VERSION}`);
    if (!h.tts || !h.tts.ready) throw unavailable("the local audio service has no speech model ready", true);
    if (h.tts.sampleRate !== WAV_SAMPLE_RATE) throw unavailable(`the speech model renders at ${h.tts.sampleRate} Hz, expected ${WAV_SAMPLE_RATE}`);

    const pinned = clonable.models?.find((m) => m.role === "voice-clone");
    if (pinned && pinned.revision !== h.tts.revision) {
      throw unavailable(`the speech model revision "${h.tts.revision}" is not the one the catalogue pins ("${pinned.revision}")`);
    }
    for (const v of clonable.voices) {
      const served = h.voices[v.id];
      if (!served) throw unavailable(`the service does not know voice "${v.id}" from the catalogue`);
      if (served.clipSha256 !== v.clip.sha256) throw unavailable(`the service's reference clip for voice "${v.id}" differs from the catalogue's`);
      if (served.transcriptSha256 !== transcriptHash(v.clip.transcript)) throw unavailable(`the service's clip transcript for voice "${v.id}" differs from the catalogue's`);
    }
    return new QwenTtsProvider(opts, base, clonable, h.tts.model, h.tts.revision);
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

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(this.token) },
        body: JSON.stringify({ voiceId: req.voiceId, text: req.text, ...(req.delivery ? { delivery: req.delivery } : {}), seed: this.seed }),
        redirect: "error",
        signal,
      });
    } catch (err) {
      throw describeFetchFailure(err, opts.signal, true);
    }

    if (!res.ok) throw await failureFromResponse(res);
    if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("audio/wav")) {
      await res.body?.cancel().catch(() => undefined);
      throw new TtsError("invalid_output", "the local audio service did not return a WAV file", true, true);
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

const authHeaders = (token: string | undefined): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** Map a failed request to a TtsError. Messages hold fixed text and codes only, never the request or the token. */
function describeFetchFailure(err: unknown, callerSignal: AbortSignal | undefined, requestSent: boolean): TtsError {
  if (callerSignal?.aborted) return new TtsError("aborted", "render aborted", requestSent, false); // the service may still be rendering
  const name = (err as Error | undefined)?.name;
  if (name === "TimeoutError") return new TtsError("timeout", "the local audio service did not answer in time", true, true);
  const code = ((err as { cause?: { code?: string } } | undefined)?.cause?.code ?? "") as string;
  if (code === "ECONNREFUSED") return unavailable("the local audio service is not running", true, false);
  return new TtsError("unavailable", "the connection to the local audio service failed", requestSent, true);
}

async function failureFromResponse(res: Response): Promise<TtsError> {
  const body = (await res.json().catch(() => undefined)) as { error?: { code?: unknown } } | undefined;
  const raw = typeof body?.error?.code === "string" ? body.error.code : "";
  const code = /^[a-z_]{1,40}$/.test(raw) ? raw : "unknown";
  const s = res.status;
  if (s === 401 || s === 403) return rejected("the local audio service refused the access token (set LOCAL_AUDIO_TOKEN)");
  if (s === 400 || s === 404 || s === 411 || s === 413 || s === 415) return rejected(`the local audio service rejected the request (HTTP ${s}, ${code})`);
  if (s === 503) return unavailable(`the local audio service is busy or not ready (${code})`, true);
  return new TtsError("service_error", `the local audio service failed (HTTP ${s}, ${code})`, true, true);
}

async function readLimited(res: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new TtsError("invalid_output", "the audio from the local audio service is too large", true, true);
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
      throw new TtsError("invalid_output", "the audio from the local audio service is too large", true, true);
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

/** Read the local audio settings. Errors name the variable but never echo its value (the token included). */
export function loadQwenConfig(env: Record<string, string | undefined> = process.env): QwenEnvConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid local audio configuration: ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")} is malformed`);
  const c = parsed.data;
  assertLoopbackUrl(c.LOCAL_AUDIO_URL);
  return { baseUrl: c.LOCAL_AUDIO_URL, token: c.LOCAL_AUDIO_TOKEN, timeoutMs: c.LOCAL_AUDIO_TIMEOUT_MS, msPerChar: c.LOCAL_AUDIO_MS_PER_CHAR, seed: c.TTS_SEED };
}
