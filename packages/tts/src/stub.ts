import { STUB_VOICE_CATALOGUE, type Delivery, type Voice } from "@midnight-radio/core";
import { rejected, SynthesisRequestSchema, TtsError, type ProviderIdentity, type SynthesisRequest, type SynthesizeOptions, type TtsProvider } from "./provider.js";
import { encodeWav, WAV_SAMPLE_RATE } from "./wav.js";

/** Duration per whitespace-delimited word, about 170 words a minute. */
export const STUB_MS_PER_WORD = 350;
const FADE_MS = 10;

const DELIVERY_AMPLITUDE: Record<Delivery, number> = { neutral: 0.4, whisper: 0.12, urgent: 0.5, fearful: 0.3, sinister: 0.35, warm: 0.4 };
const DELIVERY_PITCH: Record<Delivery, number> = { neutral: 1, whisper: 1, urgent: 1.12, fearful: 1.06, sinister: 0.9, warm: 0.97 };

/** FNV-1a: a small, stable string hash. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Offline provider for tests and CI: no model, no network. It returns a valid 24 kHz mono
 * 16-bit WAV whose length is proportional to the word count and whose pitch depends on the
 * voice, so different voices and delivery hints give different (and audibly non-silent) audio.
 * The same request always gives byte-identical output.
 */
export class StubProvider implements TtsProvider {
  readonly identity: ProviderIdentity = {
    provider: "stub",
    model: "stub-1",
    revision: "1",
    settings: { msPerWord: STUB_MS_PER_WORD, sampleRate: WAV_SAMPLE_RATE },
  };
  /** Requests received, in order (for tests). */
  readonly requests: SynthesisRequest[] = [];

  constructor(private readonly voiceList: readonly Voice[] = STUB_VOICE_CATALOGUE.voices) {}

  async voices(): Promise<Voice[]> {
    return [...this.voiceList];
  }

  voiceFingerprint(voiceId: string): string {
    if (!this.voiceList.some((v) => v.id === voiceId)) throw rejected(`unknown voice "${voiceId}"`);
    return `stub:${voiceId}:1`;
  }

  async synthesize(request: SynthesisRequest, opts: SynthesizeOptions = {}): Promise<Buffer> {
    if (opts.signal?.aborted) throw new TtsError("aborted", "render aborted", false, false);
    const parsed = SynthesisRequestSchema.safeParse(request);
    if (!parsed.success) throw rejected(`invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "request"} ${i.message}`).join("; ")}`);
    const req = parsed.data;
    this.voiceFingerprint(req.voiceId); // unknown voice
    this.requests.push(req);

    const words = (req.text.match(/\S+/g) ?? []).length;
    const ms = words * STUB_MS_PER_WORD; // a valid request has at least one word
    const frames = Math.round((ms / 1000) * WAV_SAMPLE_RATE);
    const delivery = req.delivery ?? "neutral";
    const freq = (110 + (hash(req.voiceId) % 220)) * DELIVERY_PITCH[delivery];
    const amplitude = DELIVERY_AMPLITUDE[delivery] * 32767;
    const fade = Math.round((FADE_MS / 1000) * WAV_SAMPLE_RATE);

    const samples = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      const envelope = Math.min(1, i / fade, (frames - 1 - i) / fade);
      samples[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / WAV_SAMPLE_RATE) * amplitude * Math.max(0, envelope));
    }
    // The first and last samples sit at zero by construction; make sure the clip is never all zero.
    if (samples.every((s) => s === 0)) samples[Math.floor(frames / 2)] = 1;
    return encodeWav(samples);
  }

  estimateRenderMs(chars: number): number {
    return Math.ceil(chars / 20);
  }
}
