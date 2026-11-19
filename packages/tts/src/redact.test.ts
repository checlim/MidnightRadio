import { describe, expect, it } from "vitest";
import { describeError, redactSecrets } from "./redact.js";
import { TtsError } from "./provider.js";

describe("redactSecrets", () => {
  it.each([
    ["an Authorization header", "request failed: Authorization: Bearer abcdef1234567890XYZ", "abcdef1234567890XYZ"],
    ["a bare Bearer token", "sent Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "eyJhbGciOiJIUzI1NiJ9"],
    ["an OpenAI-style key", "bad key sk-proj-AbCdEf0123456789abcdef", "sk-proj-AbCdEf0123456789abcdef"],
    ["a Hugging Face token", "download failed for hf_AbCdEfGhIjKlMnOpQrStUvWx", "hf_AbCdEfGhIjKlMnOpQrStUvWx"],
    ["a GitHub token", "push rejected ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["key=value text", "config api_key=hunter2hunter2 was rejected", "hunter2hunter2"],
    ["JSON-style fields", 'body {"token": "s3cr3t-value-123", "voice": "x"}', "s3cr3t-value-123"],
    ["a passkey", "x-midnight-passkey: open-sesame-42 invalid", "open-sesame-42"],
    ["a long opaque mixed-case string", "token was Zm9vYmFyQmF6MTIzNDU2Nzg5MEFiQ2RFZkdoSWpLbE1u here", "Zm9vYmFyQmF6MTIzNDU2Nzg5MEFiQ2RFZkdoSWpLbE1u"],
  ])("masks %s", (_label, text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("masks exact secret values anywhere, longest first, and ignores values too short to mask safely", () => {
    expect(redactSecrets("failed at http://x/?k=local-service-secret&v=1", ["local-service-secret"])).toBe("failed at http://x/?k=[redacted]&v=1");
    expect(redactSecrets("abc-secret-abc", ["abc", "abc-secret-abc"])).toBe("[redacted]");
    expect(redactSecrets("the code is 1234 and cat", ["1234", "cat"])).toBe("the code is 1234 and cat");
  });

  it.each([
    "Hello there, it is a dark night.",
    "connect ECONNREFUSED 127.0.0.1:8765",
    "render of 7834f832326432a74d5165ac889d8b4bff6dececd54ecad2730222fdb4f26a13 failed", // a cache key is not a secret
    "ENOSPC: no space left on device, write '/data/cache/render-cache.wav.tmp'",
    "the token budget for this book is used up",
    "HTTP 503 from the local audio service",
  ])("leaves ordinary diagnostics alone: %s", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("describeError", () => {
  it("summarises a TtsError by kind and retryability", () => {
    expect(describeError(new TtsError("timeout", "no answer after 90 s", true, true))).toEqual({ kind: "timeout", message: "no answer after 90 s", retryable: true });
    expect(describeError(new TtsError("rejected", "unknown voice", false, false))).toMatchObject({ kind: "rejected", retryable: false });
  });

  it("treats anything else as an internal, non-retryable error", () => {
    expect(describeError(new RangeError("offset out of bounds"))).toEqual({ kind: "internal", message: "offset out of bounds", retryable: false });
    expect(describeError("plain string")).toMatchObject({ kind: "internal", message: "plain string" });
  });

  it("redacts, collapses whitespace, shortens, and carries no stack or attached data", () => {
    const err = Object.assign(new Error(`failed\n   with Bearer abcdef1234567890 ${"x".repeat(500)}`), { headers: { authorization: "Bearer topsecret1234" } });
    const summary = describeError(err);
    expect(Object.keys(summary)).toEqual(["kind", "message", "retryable"]);
    expect(summary.message).not.toContain("abcdef1234567890");
    expect(summary.message).not.toContain("\n");
    expect(summary.message.length).toBeLessThanOrEqual(301);
    expect(JSON.stringify(summary)).not.toContain("topsecret1234");
    expect(JSON.stringify(summary)).not.toMatch(/\bat .*\.ts/);
  });

  it("applies caller-supplied secrets", () => {
    expect(describeError(new Error("denied for tok_local_4242"), ["tok_local_4242"]).message).toBe("denied for [redacted]");
  });
});
