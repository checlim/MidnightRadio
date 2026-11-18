import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicaliseText, normaliseForComparison } from "./normalise.js";

/** Property-based tests for the normaliser (design: PBT 2, first half). */

// Characters the normaliser treats specially, mixed into otherwise arbitrary text.
const TRICKY = [
  "“", "”", "„", "‟", "‘", "’", "‚", "‛", "«", "»", "‹", "›", "′", "″", '"', "'",
  "‐", "‑", "‒", "–", "—", "―", "−", "-", "…", ".",
  " ", "  ", "\t", "\n", "\n\n", "\n\n\n", "\r\n", "\r", "\u00a0", "\u2009", "\u3000", "\u2028", "\u2029", "\u0085", "\u000b", "\u000c",
  "\u00ad", "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff",
  "e\u0301", "\u0301", "A\u030a", "\u212b", "ﬁ", "Ǆ",
  // An invisible character between a letter and its combining mark: removing it must still yield NFC.
  "e\u200b\u0301", "o\u2060\u0308", "A\ufeff\u030a", "a\u00ad\u0300",
];
const tricky = fc.constantFrom(...TRICKY);
const anyText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 80 }),
  fc.array(fc.oneof(tricky, fc.string({ unit: "grapheme-ascii", maxLength: 4 }), fc.string({ unit: "binary", maxLength: 2 })), { maxLength: 40 }).map((xs) => xs.join("")),
);

const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const isSpace = (c: string) => /\s/.test(c) || c === "\u0085";
const nonSpace = (s: string) => [...s].filter((c) => !isSpace(c)).join("");
const lettersAndDigits = (s: string) => (s.match(/[\p{L}\p{N}\p{M}]/gu) ?? []).join("");

describe("property: normaliser idempotence (Req 1.4)", () => {
  it("canonicaliseText(canonicaliseText(x)) === canonicaliseText(x)", () => {
    fc.assert(fc.property(anyText, (x) => canonicaliseText(canonicaliseText(x)) === canonicaliseText(x)), { numRuns: 2_000 });
  });

  it("normaliseForComparison(normaliseForComparison(x)) === normaliseForComparison(x)", () => {
    fc.assert(fc.property(anyText, (x) => normaliseForComparison(normaliseForComparison(x)) === normaliseForComparison(x)), { numRuns: 2_000 });
  });

  it("output is always in Unicode NFC", () => {
    fc.assert(
      fc.property(anyText, (x) => {
        const c = canonicaliseText(x);
        const n = normaliseForComparison(x);
        return c === c.normalize("NFC") && n === n.normalize("NFC");
      }),
      { numRuns: 2_000 },
    );
  });

  it("comparing canonical text gives the same result as comparing the source", () => {
    fc.assert(fc.property(anyText, (x) => normaliseForComparison(canonicaliseText(x)) === normaliseForComparison(x)), { numRuns: 2_000 });
  });
});

describe("property: the normaliser never deletes words, case or punctuation (Req 1.4)", () => {
  // Reference: what may legitimately change is invisible characters (removed), NFC composition,
  // and whitespace. Everything else must survive, in order.
  const reference = (x: string) => x.replace(INVISIBLE, "").normalize("NFC");

  it("keeps every letter, digit and mark, with its case, in order", () => {
    fc.assert(
      fc.property(anyText, (x) => {
        expect(lettersAndDigits(canonicaliseText(x))).toBe(lettersAndDigits(reference(x)));
        expect(lettersAndDigits(normaliseForComparison(x))).toBe(lettersAndDigits(reference(x)));
      }),
      { numRuns: 2_000 },
    );
  });

  it("canonical text changes nothing but whitespace (beyond invisibles and NFC)", () => {
    fc.assert(fc.property(anyText, (x) => nonSpace(canonicaliseText(x)) === nonSpace(reference(x))), { numRuns: 2_000 });
  });

  it("comparison folding maps every visible character one-to-one, except … to ...", () => {
    fc.assert(
      fc.property(anyText, (x) => {
        const ref = [...nonSpace(reference(x))]; // code points, so astral characters count once
        const ellipses = ref.filter((c) => c === "…").length;
        expect([...nonSpace(normaliseForComparison(x))].length).toBe(ref.length + 2 * ellipses);
      }),
      { numRuns: 2_000 },
    );
  });

  it("keeps paragraph structure in canonical text: blank lines stay paragraph breaks", () => {
    // Paragraph text without line-break characters (\v and \f count as line breaks too).
    const para = fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 20 }).filter((s) => /\S/.test(s) && !/[\n\r\v\f]/.test(s));
    fc.assert(
      fc.property(fc.array(para, { minLength: 1, maxLength: 6 }), fc.constantFrom("\n\n", "\n\n\n", " \n\n ", "\r\n\r\n"), (paras, sep) => {
        const canon = canonicaliseText(paras.join(sep));
        expect(canon.split("\n\n").length).toBe(paras.length);
      }),
    );
  });
});
