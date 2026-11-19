import { createHash } from "node:crypto";
import type { SynthesisRequest, TtsProvider } from "./provider.js";
import { WAV_BITS, WAV_CHANNELS, WAV_SAMPLE_RATE } from "./wav.js";

/**
 * Bump when the key's contents or encoding change. Old entries then simply stop matching, and the
 * pinned golden key in the tests fails until this is bumped on purpose.
 */
export const CACHE_SCHEMA_VERSION = 1;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON with object keys sorted at every level, so equal values always encode identically. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The exact request a render cache entry answers (Req 5.2): schema version, provider/model/revision
 * and synthesis settings, voice and its fingerprint (reference-clip hash), the text exactly as
 * submitted, the delivery hint, and the output format.
 *
 * It never uses the lossy comparison normaliser: "Hello" and "Hello " are different requests, and
 * so are two spellings of the same quote. An absent delivery and an explicit "neutral" are also
 * kept apart, which at worst costs one extra render and never serves the wrong audio.
 */
export function renderCacheKey(provider: TtsProvider, req: SynthesisRequest): string {
  const { provider: name, model, revision, settings } = provider.identity;
  const tuple: Json = {
    v: CACHE_SCHEMA_VERSION,
    provider: { name, model, revision, settings: { ...settings } },
    voice: { id: req.voiceId, fingerprint: provider.voiceFingerprint(req.voiceId) },
    text: req.text,
    delivery: req.delivery ?? null,
    format: { sampleRate: WAV_SAMPLE_RATE, channels: WAV_CHANNELS, bitsPerSample: WAV_BITS },
  };
  return createHash("sha256").update(canonicalJson(tuple)).digest("hex");
}
