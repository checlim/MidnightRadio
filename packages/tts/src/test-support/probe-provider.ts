import { STUB_VOICE_CATALOGUE } from "@midnight-radio/core";
import { TtsError, type ProviderIdentity, type SynthesisRequest, type SynthesizeOptions } from "../provider.js";
import { StubProvider } from "../stub.js";

/**
 * A StubProvider that records how it was used and can be told to misbehave: delay, fail, or
 * return audio of its choosing. Identity and voice fingerprints can be changed to test cache keys.
 */
export class ProbeProvider extends StubProvider {
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  sawAbort = false;
  delayMs = 0;
  failWith: Error | undefined;
  /** Replace the audio returned for a request (e.g. garbage, or a wrong format). */
  output: ((req: SynthesisRequest) => Buffer) | undefined;
  fingerprints = new Map<string, string>();

  constructor() {
    super(STUB_VOICE_CATALOGUE.voices);
  }

  /** Change parts of the provider identity (the base class declares it read-only). */
  setIdentity(patch: Partial<ProviderIdentity>): void {
    Object.defineProperty(this, "identity", { value: { ...this.identity, ...patch }, writable: true, configurable: true, enumerable: true });
  }

  override voiceFingerprint(voiceId: string): string {
    return this.fingerprints.get(voiceId) ?? super.voiceFingerprint(voiceId);
  }

  override async synthesize(req: SynthesisRequest, opts: SynthesizeOptions = {}): Promise<Buffer> {
    this.calls++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.delayMs);
          opts.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              this.sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        if (opts.signal?.aborted) throw new TtsError("aborted", "render aborted", false, false);
      }
      if (this.failWith) throw this.failWith;
      return this.output ? this.output(req) : await super.synthesize(req, opts);
    } finally {
      this.inFlight--;
    }
  }
}
