import { z } from "zod";
import { fetchWithTimeouts } from "./long-fetch.js";
import { authHeaders, readLimited } from "./qwen-provider.js";
import { redactSecrets } from "./redact.js";
import { validateWav } from "./wav.js";

/**
 * The client for the sound-effect service API (`docs/sfx-service-api.md`), used by the worker's
 * library stage. It renders one take per call and checks the answer; the caller decides how many
 * attempts a take gets and records each one before it is sent.
 *
 * Every request carries the take's `Idempotency-Key`. A server that advertises
 * `sfx.idempotency: true` replays a finished render for a repeated key instead of rendering
 * again, so a request whose answer was lost (timeout, dropped connection, a worker restart) is
 * reconciled by sending it again with the same key. Against a server without it, an uncertain
 * request is reported as `uncertain` and the caller counts it as a used attempt.
 *
 * Plain http only on loopback; any other host needs https and a token of at least 16 characters.
 * Redirects are refused, and the token never appears in an error message.
 */

export const SFX_API_VERSION = 1;
const MIN_TOKEN_CHARS = 16;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_WAV_BYTES = 20 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DURATION_TOLERANCE_S = 0.05;

export type SfxErrorKind =
  /** Fix the configuration or the prompt list; retrying will not help. */
  | "fatal"
  /** Worth another attempt (server error, bad audio). The server answered, so nothing is pending there. */
  | "retryable"
  /** No answer: the server may have rendered it. Reconcile with the same key, or count the attempt. */
  | "uncertain"
  /** The caller's signal stopped the request. */
  | "aborted";

export class SfxError extends Error {
  constructor(
    readonly kind: SfxErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SfxError";
  }
}

export interface SfxModel {
  model: string;
  revision: string;
  weightsSha256: string | null;
  license: string;
  sampleRate: number;
  /** The server replays a finished render for a repeated Idempotency-Key. */
  idempotency: boolean;
}

const HealthSchema = z.looseObject({
  apiVersion: z.number(),
  sfx: z
    .looseObject({
      model: z.string().min(1).max(100),
      revision: z.string().min(1).max(100),
      weightsSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullish()
        .transform((v) => v ?? null),
      license: z.string().min(1).max(100),
      sampleRate: z.number().int().min(24_000).max(96_000),
      ready: z.boolean(),
      idempotency: z.boolean().optional(),
    })
    .nullable(),
});

export interface SfxRequest {
  prompt: string;
  durationSec: number;
  seed: number;
}

export interface SfxClientOptions {
  baseUrl: string;
  token?: string | undefined;
  /** Per-request timeout (default 15 minutes: a slow GPU can take that long). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** How to wait (tests pass a fake clock). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Most waits on `503 busy` / `not_ready` per request (default 10). */
  maxBusyWaits?: number;
  /** Most waits on `409 in_progress` per request (default 60). */
  maxInProgressWaits?: number;
}

/** Where sound-effect requests may be sent. Throws SfxError("fatal"). */
export function assertSfxServiceUrl(raw: string, token: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SfxError("fatal", "the sound-effect service address (SFX_SERVICE_URL) is not a valid URL");
  }
  if (url.username || url.password) throw new SfxError("fatal", "the sound-effect service address must not contain credentials; use SFX_SERVICE_TOKEN");
  if (url.search || url.hash) throw new SfxError("fatal", "the sound-effect service address must not have a query or fragment");
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  if (url.protocol !== "https:") throw new SfxError("fatal", "the sound-effect service address must be https unless it is on 127.0.0.1 or localhost");
  if (!token || token.length < MIN_TOKEN_CHARS) throw new SfxError("fatal", `a sound-effect service that is not on this machine needs SFX_SERVICE_TOKEN (at least ${MIN_TOKEN_CHARS} characters)`);
  return url;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class SfxClient {
  private constructor(
    readonly model: SfxModel,
    private readonly base: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    private readonly maxBusyWaits: number,
    private readonly maxInProgressWaits: number,
  ) {}

  /** Check `/health` and return a client pinned to the model it reports. */
  static async connect(opts: SfxClientOptions, signal?: AbortSignal): Promise<SfxClient> {
    const url = assertSfxServiceUrl(opts.baseUrl, opts.token);
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = opts.fetch ?? fetchWithTimeouts(timeoutMs);
    const model = await readHealth(base, opts.token, opts.fetch ?? fetch, signal);
    return new SfxClient(model, base, opts.token, timeoutMs, fetchImpl, opts.sleep ?? defaultSleep, opts.maxBusyWaits ?? 10, opts.maxInProgressWaits ?? 60);
  }

  /** Check the server still runs the model this client was pinned to. */
  async recheck(signal?: AbortSignal): Promise<void> {
    const now = await readHealth(this.base, this.token, this.fetchImpl, signal);
    if (now.model !== this.model.model || now.revision !== this.model.revision || now.weightsSha256 !== this.model.weightsSha256) {
      throw new SfxError("fatal", `the sound-effect server changed model during the build (now ${now.model}@${now.revision.slice(0, 12)}); start the build again`);
    }
  }

  /**
   * Render one take and return the validated WAV (mono 16-bit at the model's rate, the requested
   * length, not silent). Waits out `409 in_progress` and `503 busy`; any other failure throws.
   */
  async render(req: SfxRequest, opts: { idempotencyKey: string; signal?: AbortSignal }): Promise<Buffer> {
    if (!/^[0-9a-f]{64}$/.test(opts.idempotencyKey)) throw new SfxError("fatal", "the idempotency key must be 64 lowercase hex characters");
    let busyWaits = 0;
    let progressWaits = 0;
    for (;;) {
      if (opts.signal?.aborted) throw new SfxError("aborted", "stopped");
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/sfx`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": opts.idempotencyKey, ...authHeaders(this.token) },
          body: JSON.stringify({ prompt: req.prompt, durationSec: req.durationSec, seed: req.seed }),
          redirect: "error",
          signal,
        });
      } catch (err) {
        throw this.fetchFailure(err, opts.signal);
      }
      if (res.status === 409 || res.status === 503) {
        const code = await errorCode(res);
        const isProgress = res.status === 409 && code === "in_progress";
        if (res.status === 409 && !isProgress) throw new SfxError("fatal", `the sound-effect server answered HTTP 409 (${code})`);
        const n = isProgress ? ++progressWaits : ++busyWaits;
        if (n > (isProgress ? this.maxInProgressWaits : this.maxBusyWaits)) {
          // The render may still finish on the server; the same key collects it next time.
          throw new SfxError(isProgress ? "uncertain" : "retryable", isProgress ? "the sound-effect server is still rendering this take" : `the sound-effect server stayed busy (${code})`);
        }
        const after = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : Math.min(60_000, 1000 * 2 ** Math.min(n, 6));
        await this.sleep(waitMs, opts.signal).catch(() => {
          throw new SfxError("aborted", "stopped");
        });
        continue;
      }
      if (!res.ok) {
        const code = await errorCode(res);
        const s = res.status;
        if (s === 401 || s === 403) throw new SfxError("fatal", "the sound-effect server refused the access token (check SFX_SERVICE_TOKEN)");
        if (s === 422) throw new SfxError("fatal", `the sound-effect server says this idempotency key was used for a different request (${code})`);
        if (s === 400 || s === 404 || s === 405 || s === 411 || s === 413 || s === 415) throw new SfxError("fatal", `the sound-effect server rejected the request (HTTP ${s}, ${code})`);
        throw new SfxError("retryable", `the sound-effect server failed (HTTP ${s}, ${code})`);
      }
      if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("audio/wav")) {
        await res.body?.cancel().catch(() => undefined);
        throw new SfxError("retryable", "the sound-effect server did not return a WAV file");
      }
      const revision = res.headers.get("x-model-revision");
      if (revision !== this.model.revision) {
        await res.body?.cancel().catch(() => undefined);
        throw new SfxError("fatal", `the sound-effect model changed during the build (the take came from "${redactSecrets(revision ?? "unknown")}")`);
      }
      let bytes: Buffer;
      try {
        bytes = await readLimited(res, MAX_WAV_BYTES, signal);
      } catch (err) {
        if ((err as Error).name === "TtsError") throw new SfxError("retryable", "the audio from the sound-effect server is too large");
        throw this.fetchFailure(err, opts.signal);
      }
      checkTake(bytes, req.durationSec, this.model.sampleRate);
      return bytes;
    }
  }

  private fetchFailure(err: unknown, caller: AbortSignal | undefined): SfxError {
    if (caller?.aborted) return new SfxError("aborted", "stopped");
    const code = ((err as { cause?: { code?: string } } | undefined)?.cause?.code ?? "") as string;
    if (code === "ECONNREFUSED") return new SfxError("retryable", "the sound-effect server is not running"); // never reached it
    if ((err as Error | undefined)?.name === "TimeoutError") return new SfxError("uncertain", "the sound-effect server did not answer in time");
    return new SfxError("uncertain", "the connection to the sound-effect server failed");
  }
}

/** Validate one take as the API requires. Throws SfxError("retryable"). */
export function checkTake(bytes: Uint8Array, durationSec: number, sampleRate: number): void {
  try {
    const info = validateWav(bytes, { sampleRate, channels: 1, bitsPerSample: 16, maxDurationMs: 31_000, rejectSilence: true });
    const got = info.frames / sampleRate;
    if (Math.abs(got - durationSec) > DURATION_TOLERANCE_S) throw new Error(`it is ${got.toFixed(3)} s long, not ${durationSec} s`);
  } catch (err) {
    throw new SfxError("retryable", `the sound-effect server sent an unusable take: ${redactSecrets((err as Error).message)}`);
  }
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => undefined)) as { error?: { code?: unknown } } | undefined;
  const raw = typeof body?.error?.code === "string" ? body.error.code : "";
  return /^[a-z_]{1,40}$/.test(raw) ? raw : "unknown";
}

async function readHealth(base: string, token: string | undefined, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<SfxModel> {
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(15_000);
    res = await fetchImpl(`${base}/health`, { headers: authHeaders(token), redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    if (signal?.aborted) throw new SfxError("aborted", "stopped");
    throw new SfxError("retryable", "the sound-effect server could not be reached (check SFX_SERVICE_URL and that it is running)");
  }
  if (res.status === 401 || res.status === 403) throw new SfxError("fatal", "the sound-effect server refused the access token (check SFX_SERVICE_TOKEN)");
  if (!res.ok) throw new SfxError(res.status >= 500 ? "retryable" : "fatal", `the sound-effect server answered /health with HTTP ${res.status}`);
  const health = HealthSchema.safeParse(await res.json().catch(() => undefined));
  if (!health.success) throw new SfxError("fatal", "the sound-effect server gave an unreadable /health answer (is this a sound-effect server?)");
  const h = health.data;
  if (h.apiVersion !== SFX_API_VERSION) throw new SfxError("fatal", `the sound-effect server speaks API version ${h.apiVersion}, expected ${SFX_API_VERSION}`);
  if (!h.sfx) throw new SfxError("fatal", "the server at SFX_SERVICE_URL has no sound-effect model");
  if (!h.sfx.ready) throw new SfxError("retryable", "the sound-effect model is still loading");
  return { model: h.sfx.model, revision: h.sfx.revision, weightsSha256: h.sfx.weightsSha256, license: h.sfx.license, sampleRate: h.sfx.sampleRate, idempotency: h.sfx.idempotency === true };
}

const ConfigSchema = z.object({
  SFX_SERVICE_URL: z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined),
  SFX_SERVICE_TOKEN: z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined),
  SFX_SERVICE_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((s) => s?.trim() ?? "")
    .pipe(z.union([z.literal("").transform(() => DEFAULT_TIMEOUT_MS), z.string().regex(/^\d+$/).transform(Number).refine((n) => n >= 1_000 && n <= 3_600_000)])),
});

/** The sound-effect service settings, or null when SFX_SERVICE_URL is not set. Errors name the variable, never its value. */
export function loadSfxConfig(env: Record<string, string | undefined> = process.env): { baseUrl: string; token: string | undefined; timeoutMs: number } | null {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid sound-effect service configuration: ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")} is malformed`);
  const c = parsed.data;
  if (!c.SFX_SERVICE_URL) return null;
  assertSfxServiceUrl(c.SFX_SERVICE_URL, c.SFX_SERVICE_TOKEN);
  return { baseUrl: c.SFX_SERVICE_URL, token: c.SFX_SERVICE_TOKEN, timeoutMs: c.SFX_SERVICE_TIMEOUT_MS };
}
