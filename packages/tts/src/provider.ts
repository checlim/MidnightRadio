import { DeliverySchema, type Voice } from "@midnight-radio/core";
import { z } from "zod";

/**
 * The only way the app turns text into speech (tech.md: no direct model calls elsewhere).
 * Providers return complete WAV files; callers must still run them through `validateWav`
 * before trusting or caching them.
 */

/** Longest single request. A spoken line is far shorter; this bounds memory and render time. */
export const MAX_SYNTHESIS_CHARS = 4_000;

export const SynthesisRequestSchema = z.strictObject({
  voiceId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\w.:-]+$/, "voice ids may only contain letters, digits and . : _ -"),
  /** Submitted exactly as given: the cache key is built from it, so it is never trimmed or folded. */
  text: z
    .string()
    .max(MAX_SYNTHESIS_CHARS)
    .refine((t) => /\S/.test(t), "text must not be blank"),
  delivery: DeliverySchema.optional(),
});
export type SynthesisRequest = z.infer<typeof SynthesisRequestSchema>;

/** Everything about a provider that changes the audio it produces. Part of every cache key. */
export interface ProviderIdentity {
  /** e.g. "qwen3-tts", "stub". */
  provider: string;
  /** e.g. "Qwen3-TTS-12Hz-1.7B-Base". */
  model: string;
  /** Exact weights or implementation revision (weights hash for real models). */
  revision: string;
  /** Synthesis settings that affect output (seed, sampling parameters…). */
  settings: Readonly<Record<string, string | number | boolean>>;
}

export interface SynthesizeOptions {
  signal?: AbortSignal;
}

export interface TtsProvider {
  readonly identity: ProviderIdentity;
  /** The voices this provider can speak. */
  voices(): Promise<Voice[]>;
  /**
   * Fingerprint of whatever makes this voice sound the way it does (for cloned voices, the hash
   * of the reference clip and its transcript). Part of the cache key, so replacing a clip
   * invalidates the audio rendered with it. Throws TtsError("rejected") for an unknown voice.
   */
  voiceFingerprint(voiceId: string): string;
  /** Render one line to a complete WAV (24 kHz, mono, 16-bit). Throws TtsError on failure. */
  synthesize(req: SynthesisRequest, opts?: SynthesizeOptions): Promise<Buffer>;
  /** Estimated wall-clock time to render this many characters (Req 5.6). */
  estimateRenderMs(chars: number): number;
}

export type TtsErrorKind =
  | "rejected" // the request itself is invalid (unknown voice, bad text): retrying cannot help
  | "unavailable" // the local audio service is not reachable
  | "timeout"
  | "invalid_output" // the service answered, but the audio failed validation
  | "aborted";

/**
 * A render failed. `billed` follows the budget ledger's convention: false means no work was done
 * (the reservation can be released); true means time may have been spent, so it stays counted.
 */
export class TtsError extends Error {
  constructor(
    readonly kind: TtsErrorKind,
    message: string,
    readonly billed: boolean,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export const rejected = (message: string) => new TtsError("rejected", message, false, false);
