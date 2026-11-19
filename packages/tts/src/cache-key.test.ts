import { STUB_VOICE_CATALOGUE } from "@midnight-radio/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CACHE_SCHEMA_VERSION, canonicalJson, renderCacheKey } from "./cache-key.js";
import type { ProviderIdentity, SynthesisRequest } from "./provider.js";
import { ProbeProvider } from "./test-support/probe-provider.js";

const req = (over: Partial<SynthesisRequest> = {}): SynthesisRequest => ({ voiceId: "stub-f1", text: "Good evening, listeners.", ...over });
const key = (r: SynthesisRequest = req(), p = new ProbeProvider()) => renderCacheKey(p, r);

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } })).toBe('{"a":{"c":null,"d":[3,1,2]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });
});

describe("renderCacheKey (Req 5.2)", () => {
  it("is a stable SHA-256 hex digest", () => {
    expect(key()).toMatch(/^[0-9a-f]{64}$/);
    expect(key()).toBe(key());
  });

  it("is pinned: a change here means audio rendered earlier is no longer found. Bump CACHE_SCHEMA_VERSION on purpose.", () => {
    expect(CACHE_SCHEMA_VERSION).toBe(1);
    expect(key()).toBe("7834f832326432a74d5165ac889d8b4bff6dececd54ecad2730222fdb4f26a13");
  });

  it("does not depend on the order of the provider's settings", () => {
    const a = new ProbeProvider();
    const b = new ProbeProvider();
    a.setIdentity({ settings: { seed: 7, temperature: 0.3 } });
    b.setIdentity({ settings: { temperature: 0.3, seed: 7 } });
    expect(key(req(), a)).toBe(key(req(), b));
  });

  describe("changes with every part of the request", () => {
    const base = key();
    const withIdentity = (patch: Partial<ProviderIdentity>) => {
      const p = new ProbeProvider();
      p.setIdentity(patch);
      return key(req(), p);
    };

    it.each([
      ["provider name", () => withIdentity({ provider: "other" })],
      ["model", () => withIdentity({ model: "stub-2" })],
      ["revision (weights hash)", () => withIdentity({ revision: "2" })],
      ["a synthesis setting's value", () => withIdentity({ settings: { msPerWord: 351, sampleRate: 24_000 } })],
      ["an added synthesis setting", () => withIdentity({ settings: { msPerWord: 350, sampleRate: 24_000, seed: 1 } })],
      ["the voice", () => key(req({ voiceId: "stub-f2" }))],
      ["the voice's fingerprint (reference clip)", () => {
        const p = new ProbeProvider();
        p.fingerprints.set("stub-f1", "clip-sha256-other");
        return key(req(), p);
      }],
      ["a trailing space in the text", () => key(req({ text: "Good evening, listeners. " }))],
      ["a leading newline in the text", () => key(req({ text: "\nGood evening, listeners." }))],
      ["a different case", () => key(req({ text: "good evening, listeners." }))],
      ["a delivery hint", () => key(req({ delivery: "whisper" }))],
    ])("%s", (_label, other) => {
      expect(other()).not.toBe(base);
    });

    it("tells all six delivery hints, and no hint, apart", () => {
      const keys = new Set([undefined, "neutral", "whisper", "urgent", "fearful", "sinister", "warm"].map((d) => key(req({ delivery: d as never }))));
      expect(keys.size).toBe(7);
    });

    it("tells apart curly and straight quotes, and composed and decomposed accents", () => {
      expect(key(req({ text: "“Welcome”" }))).not.toBe(key(req({ text: '"Welcome"' })));
      expect(key(req({ text: "caf\u00e9" }))).not.toBe(key(req({ text: "cafe\u0301" })));
    });
  });

  it("property: two requests share a key exactly when every field matches", () => {
    const voice = fc.constantFrom(...STUB_VOICE_CATALOGUE.voices.slice(0, 4).map((v) => v.id));
    const text = fc.constantFrom("Hello.", "Hello. ", "hello.", "“Hello.”", '"Hello."', "Good night.");
    const delivery = fc.constantFrom(undefined, "neutral" as const, "whisper" as const, "warm" as const);
    const request = fc.record({ voiceId: voice, text, delivery }, { requiredKeys: ["voiceId", "text"] }) as fc.Arbitrary<SynthesisRequest>;
    fc.assert(
      fc.property(request, request, (a, b) => {
        const same = a.voiceId === b.voiceId && a.text === b.text && (a.delivery ?? null) === (b.delivery ?? null);
        expect(key(a) === key(b)).toBe(same);
      }),
      { numRuns: 500 },
    );
  });

  it("refuses an unknown voice", () => {
    expect(() => key(req({ voiceId: "nobody" }))).toThrow(/unknown voice/);
  });
});
