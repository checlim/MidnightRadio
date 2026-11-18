import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { extractDocument } from "./extract.js";
import { parseXhtml } from "./xml.js";

/**
 * Property-based tests for inline-safe extraction (design: PBT 2, second half): wrapping parts of
 * words in inline tags never adds whitespace inside a word, and whitespace between words, wherever
 * it sits relative to the tags, always becomes exactly one space.
 */

const INLINE = ["em", "i", "b", "strong", "span", "small", "cite", "u", "abbr", "mark"] as const;
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Words: visible characters without whitespace (including punctuation, quotes and non-Latin letters).
const word = fc
  .array(fc.constantFrom(..."abcxyzABCXYZéßΩж0123456789.,;:!?“”‘’—-()&<>'\"".split("")), { minLength: 1, maxLength: 10 })
  .map((cs) => cs.join(""));
const whitespace = fc.constantFrom(" ", "  ", "\n", "\n    ", "\t", " \n\t ");
const tag = fc.constantFrom(...INLINE);

/** One word, cut into 1–3 pieces, each optionally wrapped (possibly nested) in inline tags. */
const wrappedWord = fc
  .tuple(word, fc.array(fc.nat(), { maxLength: 2 }), fc.array(fc.array(tag, { maxLength: 2 }), { minLength: 3, maxLength: 3 }))
  .map(([w, rawCuts, wraps]) => {
    const chars = [...w];
    const cuts = [...new Set(rawCuts.map((c) => (chars.length > 1 ? 1 + (c % (chars.length - 1)) : 0)).filter((c) => c > 0))].sort((a, b) => a - b);
    const bounds = [0, ...cuts, chars.length];
    const pieces = bounds.slice(0, -1).map((b, i) => chars.slice(b, bounds[i + 1]).join(""));
    const html = pieces
      .map((piece, i) => (wraps[i] ?? []).reduceRight((inner, t) => `<${t}>${inner}</${t}>`, escape(piece)))
      .join("");
    return { word: w, html };
  });

/**
 * Join words with whitespace placed outside the tags, or tucked inside the end of the previous
 * word's tag or the start of the next word's tag: `<em>a </em>b`, `a<em> b</em>`.
 */
const paragraph = fc
  .array(fc.tuple(wrappedWord, whitespace, fc.constantFrom("outside", "end-of-previous", "start-of-next")), { minLength: 1, maxLength: 12 })
  .map((items) => {
    let html = "";
    items.forEach(([w, ws, where], i) => {
      if (i === 0) {
        html = w.html;
        return;
      }
      if (where === "outside") html += ws + w.html;
      else if (where === "end-of-previous") html = `<span>${html}${ws}</span>${w.html}`;
      else html += `<em>${ws}${w.html}</em>`;
    });
    return { words: items.map(([w]) => w.word), html };
  });

const extractParagraph = (inner: string) => {
  const doc = parseXhtml(`<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${inner}</p></body></html>`, "test.xhtml");
  return extractDocument(doc).blocks;
};

describe("property: inline-tag adjacency (Req 1.3)", () => {
  it("a word split across inline tags comes out whole, with no internal whitespace", () => {
    fc.assert(
      fc.property(wrappedWord, ({ word: w, html }) => {
        expect(extractParagraph(html)).toEqual([{ kind: "paragraph", text: w }]);
      }),
      { numRuns: 1_000 },
    );
  });

  it("whitespace between words, inside or outside tags, becomes exactly one space", () => {
    fc.assert(
      fc.property(paragraph, ({ words, html }) => {
        expect(extractParagraph(html)).toEqual([{ kind: "paragraph", text: words.join(" ") }]);
      }),
      { numRuns: 1_000 },
    );
  });

  it("leading and trailing whitespace around tags never reaches the text", () => {
    fc.assert(
      fc.property(paragraph, whitespace, whitespace, ({ words, html }, before, after) => {
        expect(extractParagraph(`${before}<i>${before}${html}${after}</i>${after}`)).toEqual([{ kind: "paragraph", text: words.join(" ") }]);
      }),
      { numRuns: 500 },
    );
  });
});
