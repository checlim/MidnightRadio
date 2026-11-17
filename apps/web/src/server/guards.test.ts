import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GenerationGuard, WindowCounter, loadGuardConfig, passkeyMatches, type GuardConfig } from "./guards.js";

const cfg = (passkey?: string): GuardConfig => ({
  passkey,
  requests: { max: 3, windowMs: 60_000 },
  passkeyFailures: { max: 2, windowMs: 120_000 },
});

describe("loadGuardConfig", () => {
  it("treats a missing or blank UPLOAD_PASSKEY as no gate", () => {
    expect(loadGuardConfig({}).passkey).toBeUndefined();
    expect(loadGuardConfig({ UPLOAD_PASSKEY: "  " }).passkey).toBeUndefined();
    expect(loadGuardConfig({ UPLOAD_PASSKEY: " s3cret " }).passkey).toBe("s3cret");
  });
});

describe("passkeyMatches", () => {
  it("matches only the exact key, regardless of length", () => {
    expect(passkeyMatches("s3cret", "s3cret")).toBe(true);
    expect(passkeyMatches("s3cre", "s3cret")).toBe(false);
    expect(passkeyMatches("s3cret!", "s3cret")).toBe(false);
    expect(passkeyMatches(undefined, "s3cret")).toBe(false);
    expect(passkeyMatches(null, "s3cret")).toBe(false);
  });

  it("property: equal iff identical", () => {
    fc.assert(fc.property(fc.string(), fc.string({ minLength: 1 }), (a, b) => passkeyMatches(a, b) === (a === b)));
  });
});

describe("GenerationGuard", () => {
  it("rate-limits every client independently and recovers after the window", () => {
    let t = 0;
    const g = new GenerationGuard(cfg(), () => t);
    for (let i = 0; i < 3; i++) expect(g.check("ip1", null)).toEqual({ ok: true });
    expect(g.check("ip1", null)).toMatchObject({ ok: false, status: 429, retryAfterSec: 60 });
    expect(g.check("ip2", null)).toEqual({ ok: true });
    t = 30_000;
    expect(g.check("ip1", null)).toMatchObject({ status: 429, retryAfterSec: 30 });
    t = 60_000;
    expect(g.check("ip1", null)).toEqual({ ok: true });
  });

  it("requires the passkey when configured and counts failed attempts against the rate limit", () => {
    let t = 0;
    const g = new GenerationGuard({ ...cfg("s3cret"), passkeyFailures: { max: 10, windowMs: 60_000 } }, () => t);
    expect(g.check("ip1", "wrong")).toMatchObject({ ok: false, status: 401 });
    expect(g.check("ip1", undefined)).toMatchObject({ ok: false, status: 401 });
    expect(g.check("ip1", "s3cret")).toEqual({ ok: true });
    expect(g.check("ip1", "s3cret")).toMatchObject({ status: 429 });
  });

  it("locks a client out after repeated wrong passkeys, even if it then sends the right one", () => {
    let t = 0;
    const g = new GenerationGuard({ ...cfg("s3cret"), requests: { max: 100, windowMs: 60_000 } }, () => t);
    expect(g.check("ip1", "a")).toMatchObject({ status: 401 });
    expect(g.check("ip1", "b")).toMatchObject({ status: 401 });
    expect(g.check("ip1", "s3cret")).toMatchObject({ status: 429, retryAfterSec: 120 });
    expect(g.check("ip2", "s3cret")).toEqual({ ok: true });
    t = 120_000;
    expect(g.check("ip1", "s3cret")).toEqual({ ok: true });
  });

  it("never echoes the passkey in responses", () => {
    const g = new GenerationGuard(cfg("s3cret"));
    expect(JSON.stringify(g.check("ip1", "guess-s3cret"))).not.toContain("s3cret");
  });
});

describe("WindowCounter", () => {
  it("bounds memory by evicting the oldest key", () => {
    const c = new WindowCounter({ max: 1, windowMs: 60_000 }, 2);
    c.hit("a", 0);
    c.hit("b", 1);
    c.hit("c", 2);
    expect(c.blockedFor("a", 3)).toBe(0); // evicted
    expect(c.blockedFor("b", 3)).toBeGreaterThan(0);
    expect(c.blockedFor("c", 3)).toBeGreaterThan(0);
  });

  it("property: never allows more than max hits per window", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 5_000 }), { maxLength: 200 }), (gaps) => {
        const limit = { max: 5, windowMs: 10_000 };
        const c = new WindowCounter(limit);
        let t = 0;
        const accepted: number[] = [];
        for (const g of gaps) {
          t += g;
          if (c.blockedFor("k", t) === 0) {
            c.hit("k", t);
            accepted.push(t);
          }
        }
        // Fixed windows allow a burst at a boundary, so any window-length span holds at most 2 * max hits.
        return accepted.every((a) => accepted.filter((b) => b >= a && b < a + limit.windowMs).length <= 2 * limit.max);
      }),
    );
  });
});
