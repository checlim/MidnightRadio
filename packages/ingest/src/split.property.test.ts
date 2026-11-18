import { canonicaliseText } from "@midnight-radio/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Block } from "./extract.js";
import { MAX_PART_WORDS, splitChapter, type ChapterPart, type QuoteSpan } from "./split.js";

/**
 * Property-based tests for the splitter (design: PBT 1). fast-check generates a compact chapter
 * description and a seed; a deterministic PRNG expands it into text, so 30,000-word chapters stay
 * fast and failures still shrink to small descriptions.
 */

const tokens = (s: string) => canonicaliseText(s).match(/\S+/g) ?? [];
const sourceOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "break" ? [] : [b.text])).join("\n\n");

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Separators an extracted paragraph can contain (whitespace is already folded, except these).
const SEPARATORS = [" ", " ", " ", " ", " ", "\u00a0", "\n", "\u2009", "\u3000"];
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function token(rnd: () => number, longTokens: boolean): string {
  const word = (min = 1, max = 8) => {
    let s = "";
    const n = min + Math.floor(rnd() * (max - min + 1));
    for (let i = 0; i < n; i++) s += LETTERS[Math.floor(rnd() * LETTERS.length)];
    return s;
  };
  const r = rnd();
  if (r < 0.62) return word();
  if (r < 0.72) return `${word()}${[".", "!", "?", ".”", "?’", "…"][Math.floor(rnd() * 6)]}`; // sentence ends
  if (r < 0.78) return `“${word()}`;
  if (r < 0.82) return `${word()}”`;
  if (r < 0.86) return `${word()}\uFEFF—\uFEFF${word()}`; // Standard Ebooks-style joiners around a dash
  if (r < 0.89) return `${word(2, 4)}\u00ad${word(2, 4)}`; // soft hyphen
  if (r < 0.91) return `${word(1, 3)}\u200b${word(1, 3)}`; // zero-width space
  if (r < 0.93) return `e\u0301${word(1, 3)}`; // combining accent (NFC composes it)
  if (r < 0.95) return "\uFEFF"; // invisible-only token: no word at all in canonical text
  if (r < 0.97) return String(Math.floor(rnd() * 10_000));
  if (longTokens && r < 0.985) return word(300, 3_000); // a single very long token counts as one word
  return word();
}

function paragraph(rnd: () => number, words: number, longTokens: boolean): string {
  let s = "";
  for (let i = 0; i < words; i++) {
    if (i > 0) s += SEPARATORS[Math.floor(rnd() * SEPARATORS.length)];
    s += token(rnd, longTokens);
  }
  return s;
}

interface ParagraphSpec {
  words: number;
  before: "none" | "hr" | "ornament" | "blank" | "heading";
}

const paragraphSpec = (maxWords: number) =>
  fc.record({
    words: fc.oneof({ weight: 6, arbitrary: fc.integer({ min: 1, max: Math.max(1, Math.floor(maxWords / 8)) }) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: maxWords }) }),
    before: fc.constantFrom<ParagraphSpec["before"]>("none", "none", "none", "hr", "ornament", "blank", "heading"),
  });

function chapter(specs: ParagraphSpec[], seed: number, longTokens: boolean): Block[] {
  const rnd = prng(seed);
  const blocks: Block[] = [];
  for (const s of specs) {
    if (s.before === "heading") blocks.push({ kind: "heading", level: 3, text: paragraph(rnd, 1 + Math.floor(rnd() * 4), false) });
    else if (s.before !== "none") blocks.push({ kind: "break", marker: s.before });
    blocks.push({ kind: "paragraph", text: paragraph(rnd, s.words, longTokens) });
  }
  return blocks;
}

/** The invariants of Req 1.5, checked for any chapter. */
function checkParts(blocks: Block[], parts: ChapterPart[], maxWords: number): void {
  const source = sourceOf(blocks);
  const all = tokens(source);

  // Every part within the limit, never empty; the single-part case is unlabelled.
  expect(parts.length > 0).toBe(all.length > 0);
  for (const p of parts) {
    expect(p.wordCount).toBeGreaterThan(0);
    expect(p.wordCount).toBeLessThanOrEqual(maxWords);
    expect(p.partCount).toBe(parts.length);
    expect(p.label).toBe(parts.length > 1 ? `Part ${p.part} of ${parts.length}` : undefined);
  }
  if (all.length <= maxWords) expect(parts.length).toBeLessThanOrEqual(1);

  // Parts are exact, ordered, non-overlapping slices; whatever lies between them has no words.
  let cursor = 0;
  parts.forEach((p, i) => {
    expect(p.part).toBe(i + 1);
    expect(p.sourceStart).toBeGreaterThanOrEqual(cursor);
    expect(p.sourceText).toBe(source.slice(p.sourceStart, p.sourceEnd));
    expect(p.canonicalText).toBe(canonicaliseText(p.sourceText));
    expect(tokens(source.slice(cursor, p.sourceStart))).toEqual([]);
    cursor = p.sourceEnd;
  });
  expect(tokens(source.slice(cursor))).toEqual([]);

  // Exact canonical token sequence: nothing dropped, duplicated or reordered.
  expect(parts.flatMap((p) => tokens(p.sourceText))).toEqual(all);
  expect(parts.reduce((s, p) => s + p.wordCount, 0)).toBe(all.length);
}

describe("property: splitter bounds and token preservation (Req 1.5)", () => {
  it("holds for small limits, where every kind of cut is exercised", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 120 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 40 }).chain((n) => fc.array(paragraphSpec(400), { minLength: n, maxLength: n })),
        (maxWords, seed, longTokens, specs) => {
          const blocks = chapter(specs, seed, longTokens);
          checkParts(blocks, splitChapter(blocks, sourceOf(blocks), { maxWords }), maxWords);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("holds at the real 8,000-word limit for chapters of up to 30,000 words", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.boolean(),
        // Paragraph sizes up to 12,000 words, so oversized paragraphs (sentence/word fallback) appear.
        fc.array(fc.record({ words: fc.oneof(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 12_000 })), before: fc.constantFrom<ParagraphSpec["before"]>("none", "none", "hr", "ornament", "blank", "heading") }), { maxLength: 60 }),
        (seed, longTokens, rawSpecs) => {
          // Cap the chapter at 30,000 words, as the design specifies.
          let budget = 30_000;
          const specs = rawSpecs.flatMap((s) => {
            const words = Math.min(s.words, budget);
            budget -= words;
            return words > 0 ? [{ ...s, words }] : [];
          });
          const blocks = chapter(specs, seed, longTokens);
          checkParts(blocks, splitChapter(blocks, sourceOf(blocks)), MAX_PART_WORDS);
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);

  it("explicitly covers a single oversized paragraph and a single enormous token", () => {
    const rnd = prng(7);
    const oversized: Block[] = [{ kind: "paragraph", text: paragraph(rnd, 20_000, true) }];
    checkParts(oversized, splitChapter(oversized, sourceOf(oversized)), MAX_PART_WORDS);
    const enormous: Block[] = [{ kind: "paragraph", text: `${"x".repeat(200_000)} ${paragraph(rnd, 9_000, false)}` }];
    const parts = splitChapter(enormous, sourceOf(enormous));
    checkParts(enormous, parts, MAX_PART_WORDS);
    expect(parts[0]!.sourceText.startsWith("x".repeat(200_000))).toBe(true);
  });
});

describe("property: quote fragments", () => {
  it("each quote's fragments are ordered, correctly flagged and together hold exactly its words", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 80 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.array(paragraphSpec(200), { minLength: 1, maxLength: 25 }),
        fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })), { maxLength: 8 }),
        (maxWords, seed, specs, rawSpans) => {
          const blocks = chapter(specs, seed, false);
          const source = sourceOf(blocks);
          // Non-overlapping spans in source order, at arbitrary character offsets.
          const cuts = rawSpans.flat().map((x) => Math.floor(x * source.length)).sort((a, b) => a - b);
          const spans: QuoteSpan[] = [];
          for (let i = 0; i + 1 < cuts.length; i += 2) if (cuts[i]! < cuts[i + 1]!) spans.push({ id: `q${i / 2}`, start: cuts[i]!, end: cuts[i + 1]! });

          const parts = splitChapter(blocks, source, { maxWords, quoteSpans: spans });
          checkParts(blocks, parts, maxWords);

          for (const q of spans) {
            const frags = parts.flatMap((p) =>
              p.quoteFragments.filter((f) => f.quoteId === q.id).map((f) => ({ ...f, text: p.sourceText.slice(f.start, f.end), abs: p.sourceStart + f.start })),
            );
            // Exactly the quote's words, in order, split only at whitespace between parts.
            expect(frags.flatMap((f) => tokens(f.text))).toEqual(tokens(source.slice(q.start, q.end)));
            frags.forEach((f, i) => {
              expect(source.slice(f.abs, f.abs + f.text.length)).toBe(f.text);
              expect(f.continuesFromPrevious).toBe(i > 0 || q.start < f.abs);
              expect(f.continuesIntoNext).toBe(i < frags.length - 1 || q.end > f.abs + f.text.length);
            });
            if (frags.length === 1 && frags[0]!.abs === q.start && frags[0]!.text.length === q.end - q.start) {
              expect(frags[0]).toMatchObject({ continuesFromPrevious: false, continuesIntoNext: false });
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
