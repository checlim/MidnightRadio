import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GenerationGuard, WindowCounter, clientKeyFromIp, loadGuardConfig, passkeyMatches, type GuardConfig } from "./guards.js";

describe("clientKeyFromIp", () => {
  it("keeps IPv4 addresses distinct and unwraps IPv4-mapped IPv6", () => {
    expect(clientKeyFromIp("203.0.113.7")).toBe("v4:203.0.113.7");
    expect(clientKeyFromIp("::ffff:203.0.113.7")).toBe("v4:203.0.113.7");
    expect(clientKeyFromIp("203.0.113.8")).not.toBe(clientKeyFromIp("203.0.113.7"));
  });

  it("groups IPv6 addresses by /64, whatever the notation", () => {
    const a = clientKeyFromIp("2001:db8:abcd:12::1");
    expect(a).toBe("v6:2001:db8:abcd:12::/64");
    expect(clientKeyFromIp("2001:0db8:abcd:0012:ffff:1:2:3")).toBe(a);
    expect(clientKeyFromIp("[2001:DB8:ABCD:12::99]")).toBe(a);
    expect(clientKeyFromIp("fe80::1%en0")).toBe("v6:fe80:0:0:0::/64");
    expect(clientKeyFromIp("2001:db8:abcd:13::1")).not.toBe(a);
  });
});

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

  it("rejects an oversized passkey without echoing it", () => {
    const huge = "k".repeat(513);
    expect(() => loadGuardConfig({ UPLOAD_PASSKEY: huge })).toThrow("invalid guard configuration: UPLOAD_PASSKEY must be at most 512 characters");
    try {
      loadGuardConfig({ UPLOAD_PASSKEY: huge });
    } catch (e) {
      expect((e as Error).message).not.toContain("kkkk");
    }
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

  it("a client cannot clear its own lockout by flooding the table with other keys", () => {
    const t = 0;
    const g = new GenerationGuard(
      { passkey: "s3cret", requests: { max: 100, windowMs: 60_000 }, passkeyFailures: { max: 2, windowMs: 120_000 } },
      () => t,
    );
    g.check("attacker", "a");
    g.check("attacker", "b"); // locked out
    for (let i = 0; i < 20_000; i++) g.check(`rotated-${i}`, null); // more keys than the table holds
    expect(g.check("attacker", "s3cret")).toMatchObject({ status: 429 });
  });

  it("never echoes the passkey in responses", () => {
    const g = new GenerationGuard(cfg("s3cret"));
    expect(JSON.stringify(g.check("ip1", "guess-s3cret"))).not.toContain("s3cret");
  });
});

describe("WindowCounter", () => {
  it("never evicts a live entry; refuses new keys while full, then frees expired slots", () => {
    const c = new WindowCounter({ max: 1, windowMs: 60_000 }, 2);
    expect(c.hit("a", 0)).toBe(true);
    expect(c.hit("b", 1)).toBe(true);
    expect(c.hit("c", 2)).toBe(false); // full of live entries
    expect(c.blockedFor("c", 2)).toBe(60); // until "a" expires
    expect(c.blockedFor("a", 3)).toBeGreaterThan(0); // still tracked and limited
    expect(c.blockedFor("c", 60_000)).toBe(0); // "a" has expired
    expect(c.hit("c", 60_000)).toBe(true);
  });

  it("property: a window-length span never holds more than 2 * max accepted hits", () => {
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
