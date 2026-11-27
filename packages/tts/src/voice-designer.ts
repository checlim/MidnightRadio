import { createHash } from "node:crypto";
import { z } from "zod";
import { fetchWithTimeouts } from "./long-fetch.js";
import { TtsError, rejected } from "./provider.js";
import { LOCAL_AUDIO_API_VERSION, SPEECH_LANGUAGE, assertServiceUrl, authHeaders, describeFetchFailure, failureFromResponse, readLimited, unavailable } from "./qwen-provider.js";
import { WavError, encodeWav, validateWav } from "./wav.js";

/**
 * Designing a book's character voices (docs/tts-service-api.md, `POST /voice-design`): a written
 * voice description in, a reference clip out. Like the speech provider, the server is a plain
 * engine; this client pins the voice-design build (`assets/voices/voice-design.json`), sends the
 * description, the fixed sentence and a seed, and checks every clip before it becomes a voice.
 */

/** Every designed voice says this, as the series voices do, so voices stay comparable and carry no book text. */
export const DESIGN_SENTENCE = "Good evening. The night is cold, the road is long, and the old house waits at the end of it.";
/** Characters a voice description may have (the server's limit). */
export const MAX_INSTRUCT_CHARS = 500;

export const VoiceDesignPinSchema = z.object({
  name: z.string().min(1).max(200),
  revision: z.string().min(1).max(200),
  weightsSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).passthrough();
export type VoiceDesignPin = z.infer<typeof VoiceDesignPinSchema>;

export interface DesignRequest {
  instruct: string;
  text: string;
  seed: number;
}

export interface VoiceDesigner {
  readonly identity: { model: string; revision: string; weightsSha256?: string };
  design(req: DesignRequest, opts?: { signal?: AbortSignal }): Promise<Buffer>;
}

export type ClipVerdict = { ok: true; durationMs: number } | { ok: false; reason: string };

/**
 * Whether a designed clip can be a voice's reference: a valid 24 kHz mono 16-bit WAV, 2–20 s
 * long, audible (RMS above −40 dBFS) and not clipping (under 0.1 % of samples at full scale).
 */
export function checkDesignedClip(wav: Uint8Array): ClipVerdict {
  let info;
  try {
    info = validateWav(wav, { maxDurationMs: 60_000, rejectSilence: false });
  } catch (err) {
    return { ok: false, reason: err instanceof WavError ? `not a usable WAV (${err.message})` : "not a usable WAV" };
  }
  if (info.durationMs < 2_000 || info.durationMs > 20_000) return { ok: false, reason: `${(info.durationMs / 1000).toFixed(1)} s long; a reference clip needs 2 to 20 s` };
  const samples = new Int16Array(wav.buffer.slice(wav.byteOffset + info.dataOffset, wav.byteOffset + info.dataOffset + info.dataLength));
  let sum = 0;
  let clipped = 0;
  for (const v of samples) {
    sum += (v / 32768) ** 2;
    if (Math.abs(v) >= 32_700) clipped++;
  }
  const rmsDb = 10 * Math.log10(sum / Math.max(1, samples.length) || 1e-12);
  if (rmsDb < -40) return { ok: false, reason: `nearly silent (${rmsDb.toFixed(1)} dBFS)` };
  if (clipped / samples.length > 0.001) return { ok: false, reason: "clips" };
  return { ok: true, durationMs: info.durationMs };
}

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const HealthSchema = z.looseObject({
  apiVersion: z.number(),
  voiceDesign: z
    .object({ model: z.string().min(1).max(200), revision: z.string().min(1).max(200), weightsSha256: sha.nullish().transform((v) => v ?? undefined), sampleRate: z.number(), ready: z.boolean() })
    .nullish(),
});

export interface QwenVoiceDesignerOptions {
  baseUrl: string;
  token?: string | undefined;
  pin: VoiceDesignPin;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class QwenVoiceDesigner implements VoiceDesigner {
  private constructor(
    readonly identity: { model: string; revision: string; weightsSha256?: string },
    private readonly base: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** Connect and check that the server's voice-design model is the pinned build. Throws TtsError otherwise. */
  static async connect(opts: QwenVoiceDesignerOptions): Promise<QwenVoiceDesigner> {
    const url = assertServiceUrl(opts.baseUrl, opts.token);
    const pin = VoiceDesignPinSchema.parse(opts.pin);
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
    const parsed = HealthSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw unavailable("the speech service gave an unreadable /health answer (is this a speech server?)");
    const h = parsed.data;
    if (h.apiVersion !== LOCAL_AUDIO_API_VERSION) throw unavailable(`the speech service speaks API version ${h.apiVersion}, expected ${LOCAL_AUDIO_API_VERSION}`);
    const d = h.voiceDesign;
    if (!d) throw unavailable("the speech service has no voice-design model (start it with voice design enabled)");
    if (!d.ready) throw unavailable("the speech service's voice-design model is not ready yet", true);
    if (d.sampleRate !== 24_000) throw unavailable(`the voice-design model renders at ${d.sampleRate} Hz, expected 24000`);
    if (d.model !== pin.name) throw unavailable(`the speech service designs voices with "${d.model}", not the pinned "${pin.name}"`);
    if (d.revision !== pin.revision) throw unavailable(`the voice-design revision "${d.revision}" is not the pinned "${pin.revision}"`);
    if (pin.weightsSha256 && d.weightsSha256 !== pin.weightsSha256) throw unavailable("the voice-design weights are not the pinned ones");
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    return new QwenVoiceDesigner({ model: d.model, revision: d.revision, ...(d.weightsSha256 ? { weightsSha256: d.weightsSha256 } : {}) }, base, opts.token, timeoutMs, opts.fetch ?? fetchWithTimeouts(timeoutMs));
  }

  async design(req: DesignRequest, opts: { signal?: AbortSignal } = {}): Promise<Buffer> {
    const instruct = req.instruct.trim();
    if (!instruct || instruct.length > MAX_INSTRUCT_CHARS) throw rejected(`a voice description must be 1 to ${MAX_INSTRUCT_CHARS} characters`);
    if (!req.text.trim() || req.text.length > 500) throw rejected("the design sentence must be 1 to 500 characters");
    if (!Number.isInteger(req.seed) || req.seed < 0 || req.seed > 2 ** 31 - 1) throw rejected("the seed must be an integer from 0 to 2147483647");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/voice-design`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(this.token) },
        body: JSON.stringify({ instruct, text: req.text, language: SPEECH_LANGUAGE, seed: req.seed }),
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
    if (res.headers.get("x-model-revision") !== this.identity.revision) {
      await res.body?.cancel().catch(() => undefined);
      throw new TtsError("unavailable", "the voice-design model changed while connected; reconnect to the service", true, false);
    }
    return readLimited(res, 16 * 1024 * 1024, signal);
  }
}

/** Offline designer for tests and stub mode: a tone per description and seed. Never calls a server. */
export class StubVoiceDesigner implements VoiceDesigner {
  readonly identity = { model: "stub-voice-design", revision: "stub-1" };
  readonly requests: DesignRequest[] = [];
  /** Seeds for which the "model" returns silence, to exercise the retry. */
  constructor(private readonly silentSeeds: ReadonlySet<number> = new Set()) {}

  async design(req: DesignRequest): Promise<Buffer> {
    this.requests.push(req);
    const h = createHash("sha256").update(`${req.instruct}\0${req.seed}`).digest();
    const freq = 110 + (h.readUInt16BE(0) % 220);
    const amp = this.silentSeeds.has(req.seed) ? 0 : 0.3;
    const frames = 24_000 * 4;
    return encodeWav(Int16Array.from({ length: frames }, (_, i) => Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / 24_000) * Math.min(1, i / 2400, (frames - i) / 2400))));
  }
}
