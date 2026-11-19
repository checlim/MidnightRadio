import { STUB_VOICE_CATALOGUE } from "@midnight-radio/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_SYNTHESIS_CHARS, SynthesisRequestSchema, TtsError, type TtsProvider } from "./provider.js";
import { STUB_MS_PER_WORD, StubProvider } from "./stub.js";
import { validateWav } from "./wav.js";

const stub = () => new StubProvider();
const say = (text: string, voiceId = "stub-f1", delivery?: "whisper") => ({ voiceId, text, ...(delivery ? { delivery } : {}) });
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
async function failure(p: Promise<unknown>): Promise<TtsError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TtsError) return e;
    throw e;
  }
  throw new Error("expected a TtsError");
}

describe("StubProvider output (Req 5.4)", () => {
  it("is a valid 24 kHz mono 16-bit WAV that is not silent", async () => {
    const info = validateWav(await stub().synthesize(say("Good evening, listeners.")));
    expect(info).toMatchObject({ sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    expect(info.peak).toBeGreaterThan(1_000);
  });

  it("is proportional to the word count", async () => {
    const ms = async (text: string) => validateWav(await stub().synthesize(say(text))).durationMs;
    expect(await ms("Hi")).toBe(STUB_MS_PER_WORD);
    expect(await ms(words(10))).toBe(10 * STUB_MS_PER_WORD);
    expect(await ms(words(40))).toBe(40 * STUB_MS_PER_WORD);
    expect(await ms("  spaced \n\n out\twords  ")).toBe(3 * STUB_MS_PER_WORD);
  });

  it("property: length tracks the word count to within a frame", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 120 }), async (n) => {
        const info = validateWav(await stub().synthesize(say(words(n))));
        const expectedFrames = Math.round(((n * STUB_MS_PER_WORD) / 1000) * 24_000);
        expect(info.frames).toBe(expectedFrames);
      }),
      { numRuns: 60 },
    );
  });

  it("is byte-identical for the same request, and differs by voice and by delivery", async () => {
    const a = await stub().synthesize(say("The night air is chill."));
    expect((await stub().synthesize(say("The night air is chill."))).equals(a)).toBe(true);
    expect((await stub().synthesize(say("The night air is chill.", "stub-m2"))).equals(a)).toBe(false);
    const whisper = await stub().synthesize(say("The night air is chill.", "stub-f1", "whisper"));
    expect(whisper.equals(a)).toBe(false);
    expect(validateWav(whisper).peak).toBeLessThan(validateWav(a).peak);
  });

  it("works for every voice in the catalogue, including the reserved ones", async () => {
    for (const v of STUB_VOICE_CATALOGUE.voices) expect(validateWav(await stub().synthesize(say("Hello there.", v.id))).frames).toBeGreaterThan(0);
  });

  it("starts and ends at zero, so a clip never clicks", async () => {
    const wav = await stub().synthesize(say("Hello there."));
    const info = validateWav(wav);
    expect(wav.readInt16LE(info.dataOffset)).toBe(0);
    expect(wav.readInt16LE(info.dataOffset + info.dataLength - 2)).toBe(0);
  });
});

describe("StubProvider contract", () => {
  it("exposes an identity for cache keys and a fingerprint per voice", () => {
    const p = stub();
    expect(p.identity).toEqual({ provider: "stub", model: "stub-1", revision: "1", settings: { msPerWord: 350, sampleRate: 24_000 } });
    expect(p.voiceFingerprint("stub-f1")).not.toBe(p.voiceFingerprint("stub-f2"));
    expect(p.voiceFingerprint("stub-f1")).toBe(p.voiceFingerprint("stub-f1"));
  });

  it("lists the catalogue's voices", async () => {
    expect((await stub().voices()).map((v) => v.id)).toEqual(STUB_VOICE_CATALOGUE.voices.map((v) => v.id));
  });

  it("estimates render time that grows with length", () => {
    const p: TtsProvider = stub();
    expect(p.estimateRenderMs(0)).toBe(0);
    expect(p.estimateRenderMs(2_000)).toBeGreaterThan(p.estimateRenderMs(200));
  });

  it("records the exact text it was given, untrimmed", async () => {
    const p = stub();
    await p.synthesize(say("  “Welcome,”\n he said. "));
    expect(p.requests[0]!.text).toBe("  “Welcome,”\n he said. ");
  });
});

describe("StubProvider refusals", () => {
  it.each([
    ["an unknown voice", say("Hello", "nobody"), /unknown voice/],
    ["blank text", say("  \n\t "), /must not be blank/],
    ["empty text", say(""), /must not be blank/],
    ["text over the limit", say("x".repeat(MAX_SYNTHESIS_CHARS + 1)), /text/],
    ["a bad voice id", say("Hello", "has space"), /voiceId/],
    ["an unknown delivery", { voiceId: "stub-f1", text: "Hi", delivery: "shouting" } as never, /delivery/],
    ["an unknown field", { voiceId: "stub-f1", text: "Hi", pitch: 2 } as never, /request|pitch/],
  ])("rejects %s as a request error that retrying cannot fix", async (_label, req, message) => {
    const e = await failure(stub().synthesize(req));
    expect(e).toMatchObject({ kind: "rejected", billed: false, retryable: false });
    expect(e.message).toMatch(message);
  });

  it("accepts text at exactly the limit", async () => {
    expect(SynthesisRequestSchema.safeParse(say("x".repeat(MAX_SYNTHESIS_CHARS))).success).toBe(true);
  });

  it("stops before doing any work when already aborted", async () => {
    const p = stub();
    const e = await failure(p.synthesize(say("Hello"), { signal: AbortSignal.abort() }));
    expect(e).toMatchObject({ kind: "aborted", billed: false, retryable: false });
    expect(p.requests).toHaveLength(0);
  });
});
