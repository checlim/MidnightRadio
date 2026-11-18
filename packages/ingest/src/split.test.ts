import { canonicaliseText } from "@midnight-radio/core";
import { describe, expect, it } from "vitest";
import { ingestEpub } from "./epub.js";
import type { Block } from "./extract.js";
import { splitChapter, type ChapterPart } from "./split.js";
import { buildEpub } from "./test-support/build-epub.js";

const words = (n: number, w = "w") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
const p = (text: string): Block => ({ kind: "paragraph", text });
const hr: Block = { kind: "break", marker: "hr" };
const blank: Block = { kind: "break", marker: "blank" };
const sourceOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "break" ? [] : [b.text])).join("\n\n");
const split = (blocks: Block[], opts: Parameters<typeof splitChapter>[2] = {}) => splitChapter(blocks, sourceOf(blocks), opts);
const tokens = (s: string) => canonicaliseText(s).match(/\S+/g) ?? [];

/** The invariants every split must keep: limit, exact slices, token order. */
function expectSound(parts: ChapterPart[], blocks: Block[], maxWords: number) {
  const source = sourceOf(blocks);
  for (const part of parts) {
    expect(part.wordCount).toBeLessThanOrEqual(maxWords);
    expect(part.sourceText).toBe(source.slice(part.sourceStart, part.sourceEnd));
    expect(part.canonicalText).toBe(canonicaliseText(part.sourceText));
  }
  expect(parts.flatMap((x) => tokens(x.sourceText))).toEqual(tokens(source));
}

describe("splitChapter (Req 1.5)", () => {
  it("returns one unlabelled part for a chapter within the limit", () => {
    const blocks = [p(words(10)), hr, p(words(5))];
    const parts = split(blocks, { maxWords: 20 });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ part: 1, partCount: 1, label: undefined, wordCount: 15, blocks });
  });

  it("uses the fewest parts, labels them 'Part i of N', keeps the limit and balances sizes", () => {
    // Ten 30-word paragraphs, limit 100: three paragraphs fit per part, so four parts are needed.
    const blocks = Array.from({ length: 10 }, (_, i) => p(words(30, `p${i}w`)));
    const parts = split(blocks, { maxWords: 100 });
    expect(parts.map((x) => x.label)).toEqual(["Part 1 of 4", "Part 2 of 4", "Part 3 of 4", "Part 4 of 4"]);
    expect(parts.map((x) => x.part)).toEqual([1, 2, 3, 4]);
    expect(parts.reduce((s, x) => s + x.wordCount, 0)).toBe(300);
    const sizes = parts.map((x) => x.wordCount);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(30); // 90/60/90/60, not 90/90/90/30
    expectSound(parts, blocks, 100);
  });

  it("prefers a scene break over a slightly better-balanced paragraph boundary", () => {
    // 6 paragraphs of 20 words; a scene break after paragraph 2 (40 words) vs balanced cut after 3 (60).
    const blocks = [p(words(20, "a")), p(words(20, "b")), hr, p(words(20, "c")), p(words(20, "d")), p(words(20, "e")), p(words(20, "f"))];
    const parts = split(blocks, { maxWords: 80 });
    expect(parts.map((x) => x.wordCount)).toEqual([40, 80]);
    expect(parts[1]!.blocks[0]).toEqual(p(words(20, "c"))); // the break itself is not carried into the part
    expectSound(parts, blocks, 80);
  });

  it("but does not take a scene break that makes parts badly unbalanced", () => {
    // The 10/90 cut at the scene break is allowed (limit 95) but far worse balanced than 50/50.
    const blocks = [p(words(10, "a")), hr, ...Array.from({ length: 9 }, (_, i) => p(words(10, `b${i}`)))];
    const parts = split(blocks, { maxWords: 95 });
    expect(parts.map((x) => x.wordCount)).toEqual([50, 50]);
  });

  it("prefers headings and blank paragraphs over plain paragraph ends", () => {
    const blocks = [p(words(20, "a")), p(words(20, "b")), { kind: "heading", level: 3, text: "Later" } as Block, p(words(20, "c")), p(words(20, "d"))];
    const parts = split(blocks, { maxWords: 60 });
    expect(parts[1]!.blocks[0]).toEqual({ kind: "heading", level: 3, text: "Later" });
    // A perfectly balanced paragraph cut (40/40) loses to a nearly balanced blank-paragraph cut (45/35).
    const withBlank = [p(words(20, "a")), p(words(20, "b")), p(words(5, "c")), blank, p(words(15, "d")), p(words(20, "e"))];
    expect(split(withBlank, { maxWords: 60 }).map((x) => x.wordCount)).toEqual([45, 35]);
  });

  it("keeps breaks between paragraphs inside a part", () => {
    const blocks = [p(words(5, "a")), hr, p(words(5, "b")), p(words(50, "c"))];
    const parts = split(blocks, { maxWords: 50 });
    expect(parts[0]!.blocks).toEqual([p(words(5, "a")), hr, p(words(5, "b"))]);
  });

  it("splits an oversized paragraph at sentence ends", () => {
    const sentences = Array.from({ length: 6 }, (_, i) => `${words(9, `s${i}w`)} end${i}.`);
    const blocks = [p(sentences.join(" "))];
    const parts = split(blocks, { maxWords: 30 });
    expect(parts.map((x) => x.wordCount)).toEqual([30, 30]);
    expect(parts[0]!.sourceText.endsWith("end2.")).toBe(true);
    expect(parts[1]!.blocks).toEqual([p(parts[1]!.sourceText)]);
    expectSound(parts, blocks, 30);
  });

  it("treats closing quotes after a full stop as part of the sentence end", () => {
    const text = `${words(8)} “Stop.” ${words(8, "x")} said he. ${words(8, "y")}`;
    const parts = split([p(text)], { maxWords: 12 });
    expect(parts[0]!.sourceText.endsWith("“Stop.”")).toBe(true);
  });

  it("falls back to word boundaries for a sentence that is itself too long, counting long tokens as one word", () => {
    const blocks = [p(`${words(25)} ${"x".repeat(500)} ${words(20, "z")}`)];
    const parts = split(blocks, { maxWords: 10 });
    expect(parts.length).toBe(5);
    expect(parts.every((x) => x.wordCount <= 10)).toBe(true);
    expectSound(parts, blocks, 10);
  });

  it("never cuts at invisible joiners that canonical text removes", () => {
    // U+FEFF counts as whitespace in JavaScript regexes but is not whitespace in canonical text.
    const glued = Array.from({ length: 40 }, (_, i) => `a${i}\uFEFF—b${i}`).join(" ");
    const blocks = [p(glued)];
    const parts = split(blocks, { maxWords: 15 });
    expectSound(parts, blocks, 15);
    for (const part of parts) expect(part.sourceText.startsWith("\uFEFF") || part.sourceText.endsWith("\uFEFF")).toBe(false);
  });
});

describe("quote fragments at part boundaries", () => {
  it("avoids cutting inside a quote, even when that cut would be the best balanced", () => {
    // The 40/40 cut falls inside the two-paragraph quote; 20/60 and 60/20 cuts keep it whole.
    const blocks = [p(words(20, "a")), p(`“${words(20, "q")}`), p(`${words(20, "r")}”`), p(words(20, "b"))];
    const source = sourceOf(blocks);
    const start = source.indexOf("“");
    const end = source.indexOf("”") + 1;
    const parts = splitChapter(blocks, source, { maxWords: 60, quoteSpans: [{ id: "q1", start, end }] });
    expect(parts.map((x) => x.wordCount).sort()).toEqual([20, 60]);
    const holder = parts.find((x) => x.quoteFragments.length > 0)!;
    expect(parts.flatMap((x) => x.quoteFragments)).toEqual([
      { quoteId: "q1", start: start - holder.sourceStart, end: end - holder.sourceStart, continuesFromPrevious: false, continuesIntoNext: false },
    ]);
    // Without the quote span, the balanced cut inside it wins.
    expect(split(blocks, { maxWords: 60 }).map((x) => x.wordCount)).toEqual([40, 40]);
  });

  it("gives each part the exact intersecting fragment, the parent id and continuation flags", () => {
    const blocks = [p(words(10, "a")), p(`“${words(30, "q")}`), p(`${words(30, "r")}”`), p(words(10, "b"))];
    const source = sourceOf(blocks);
    const start = source.indexOf("“");
    const end = source.indexOf("”") + 1;
    const parts = splitChapter(blocks, source, { maxWords: 45, quoteSpans: [{ id: "q1", start, end }] });
    expect(parts.length).toBe(2);
    const [first, second] = parts as [ChapterPart, ChapterPart];
    const f1 = first.quoteFragments[0]!;
    const f2 = second.quoteFragments[0]!;
    expect(f1).toMatchObject({ quoteId: "q1", continuesFromPrevious: false, continuesIntoNext: true });
    expect(f2).toMatchObject({ quoteId: "q1", continuesFromPrevious: true, continuesIntoNext: false });
    // Fragments are exact slices of the original quote, and together cover all of its words.
    const pieces = first.sourceText.slice(f1.start, f1.end) + " " + second.sourceText.slice(f2.start, f2.end);
    expect(tokens(pieces)).toEqual(tokens(source.slice(start, end)));
    expect(first.sourceText.slice(f1.start).startsWith("“")).toBe(true);
    expect(second.sourceText.slice(0, f2.end).endsWith("”")).toBe(true);
  });
});

describe("scene breaks and parts in ingested books", () => {
  it("turns ornament paragraphs into scene breaks and keeps them out of the text", async () => {
    const book = await ingestEpub(
      await buildEpub({ docs: [{ id: "c", href: "c.xhtml", body: `<p>One.</p><p class="center">* * *</p><p>Two.</p><p>⁂</p><p>Three.</p><p>— and so on.</p>` }] }),
    );
    const ch = book.chapters[0]!;
    expect(ch.blocks.filter((b) => b.kind === "break")).toEqual([
      { kind: "break", marker: "ornament" },
      { kind: "break", marker: "ornament" },
    ]);
    expect(ch.sourceText).toBe("One.\n\nTwo.\n\nThree.\n\n— and so on.");
  });

  it("splits long chapters into labelled parts and leaves short ones whole", async () => {
    const long = Array.from({ length: 9 }, (_, i) => `<p>${words(1_000, `c${i}w`)}.</p>`).join("");
    const book = await ingestEpub(
      await buildEpub({
        docs: [
          { id: "a", href: "a.xhtml", body: `<h1>Short</h1><p>${words(50)}.</p>` },
          { id: "b", href: "b.xhtml", body: `<h1>Long</h1>${long}` },
        ],
      }),
    );
    const [short, longCh] = book.chapters as [(typeof book.chapters)[0], (typeof book.chapters)[0]];
    expect(short.parts.map((x) => x.label)).toEqual([undefined]);
    expect(longCh.wordCount).toBe(9_000);
    expect(longCh.parts.map((x) => [x.label, x.wordCount])).toEqual([
      ["Part 1 of 2", 5_000],
      ["Part 2 of 2", 4_000],
    ]);
  });
});
