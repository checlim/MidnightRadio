import { canonicaliseText } from "@midnight-radio/core";
import type { Block } from "./extract.js";

/** Req 1.5: no part may exceed this many words. */
export const MAX_PART_WORDS = 8_000;

/** A source quote, as character offsets into the chapter's `sourceText` (end exclusive). */
export interface QuoteSpan {
  id: string;
  start: number;
  end: number;
}

/** The piece of a source quote that falls inside one part, in that part's `sourceText` offsets. */
export interface QuoteFragment {
  quoteId: string;
  start: number;
  end: number;
  /** The quote began in an earlier part. */
  continuesFromPrevious: boolean;
  /** The quote carries on into a later part. */
  continuesIntoNext: boolean;
}

export interface ChapterPart {
  /** 1-based. */
  part: number;
  partCount: number;
  /** "Part 1 of N" when the chapter was split, otherwise undefined. */
  label: string | undefined;
  blocks: Block[];
  /** Exact slice `chapter.sourceText.slice(sourceStart, sourceEnd)`. */
  sourceText: string;
  canonicalText: string;
  wordCount: number;
  sourceStart: number;
  sourceEnd: number;
  quoteFragments: QuoteFragment[];
}

/**
 * Whitespace that `canonicaliseText` keeps as whitespace. Cuts happen only here, never at the
 * invisible characters it removes (U+FEFF, U+200B…), so canonical tokens are preserved exactly.
 */
const CUT_SPACE = "[ \\t\\n\\r\\f\\v\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]";
const CUT_SPACE_RUN = new RegExp(`${CUT_SPACE}+`, "g");
const SENTENCE_END = new RegExp(`[.!?…]["”’')\\]]*(?=${CUT_SPACE})`, "g");

export const countCanonicalWords = (sourceSlice: string): number => (canonicaliseText(sourceSlice).match(/\S+/g) ?? []).length;

/** How good a place the boundary before a segment is for a cut. Higher is better. */
const Boundary = {
  Word: 0,
  Sentence: 1,
  Paragraph: 2,
  Soft: 3, // heading or blank paragraph
  Scene: 4, // <hr> or ornament
} as const;
type Boundary = (typeof Boundary)[keyof typeof Boundary];
const CUT_PENALTY: Record<Boundary, number> = {
  [Boundary.Scene]: 0,
  [Boundary.Soft]: 0.1,
  [Boundary.Paragraph]: 0.3,
  [Boundary.Sentence]: 1,
  [Boundary.Word]: 3,
};
const INSIDE_QUOTE_PENALTY = 2;

interface Segment {
  start: number;
  end: number;
  words: number;
  /** Quality of the boundary before this segment. */
  before: Boundary;
  /** Index into the chapter's text blocks (paragraphs and headings). */
  block: number;
}

interface TextBlock {
  block: Block & { text: string };
  start: number;
  end: number;
  before: Boundary;
}

/**
 * Split a chapter into parts of at most `maxWords` canonical words (Req 1.5). Chapters within
 * the limit come back as a single unlabelled part. Uses the fewest parts possible, then picks
 * cut points that keep parts balanced and prefer scene breaks, then headings/blank paragraphs,
 * then paragraph ends; sentence and word cuts only inside a paragraph that is itself too long.
 * Cuts avoid quote spans when they can, and each part gets its quote fragments.
 */
export function splitChapter(
  blocks: Block[],
  sourceText: string,
  opts: { maxWords?: number; quoteSpans?: QuoteSpan[] } = {},
): ChapterPart[] {
  const maxWords = opts.maxWords ?? MAX_PART_WORDS;
  const spans = opts.quoteSpans ?? [];
  const text = layoutTextBlocks(blocks, sourceText);
  const segments = toSegments(text, sourceText, maxWords);
  if (segments.length === 0) return [];

  const total = segments.reduce((s, x) => s + x.words, 0);
  const groups = total <= maxWords ? [[0, segments.length] as const] : partition(segments, maxWords, spans);

  return groups.map(([from, to], i) => {
    const sourceStart = segments[from]!.start;
    const sourceEnd = segments[to - 1]!.end;
    const slice = sourceText.slice(sourceStart, sourceEnd);
    return {
      part: i + 1,
      partCount: groups.length,
      label: groups.length > 1 ? `Part ${i + 1} of ${groups.length}` : undefined,
      blocks: partBlocks(blocks, text, segments.slice(from, to), sourceText),
      sourceText: slice,
      canonicalText: canonicaliseText(slice),
      wordCount: countCanonicalWords(slice),
      sourceStart,
      sourceEnd,
      quoteFragments: fragmentsFor(spans, sourceStart, sourceEnd),
    };
  });
}

/** Locate each paragraph/heading in `sourceText` (joined by "\n\n") and grade the boundary before it. */
function layoutTextBlocks(blocks: Block[], sourceText: string): TextBlock[] {
  const out: TextBlock[] = [];
  let offset = 0;
  let pending: Boundary = Boundary.Paragraph;
  for (const b of blocks) {
    if (b.kind === "break") {
      pending = Math.max(pending, b.marker === "blank" ? Boundary.Soft : Boundary.Scene) as Boundary;
      continue;
    }
    if (out.length > 0) offset += 2; // the "\n\n" separator
    const start = offset;
    const end = start + b.text.length;
    if (sourceText.slice(start, end) !== b.text) throw new Error("splitChapter: blocks do not match sourceText");
    const before = (b.kind === "heading" ? Math.max(pending, Boundary.Soft) : pending) as Boundary;
    out.push({ block: b, start, end, before });
    offset = end;
    pending = Boundary.Paragraph;
  }
  if (offset !== sourceText.length) throw new Error("splitChapter: blocks do not cover sourceText");
  return out;
}

/** Paragraphs are atomic unless longer than `maxWords`; then sentences, then word chunks. */
function toSegments(text: TextBlock[], sourceText: string, maxWords: number): Segment[] {
  const out: Segment[] = [];
  text.forEach((t, block) => {
    const words = countCanonicalWords(sourceText.slice(t.start, t.end));
    if (words === 0) return;
    if (words <= maxWords) {
      out.push({ start: t.start, end: t.end, words, before: t.before, block });
      return;
    }
    const sentences = cutAt(sourceText, t.start, t.end, SENTENCE_END);
    sentences.forEach(([s, e], i) => {
      const before = i === 0 ? t.before : Boundary.Sentence;
      const w = countCanonicalWords(sourceText.slice(s, e));
      if (w <= maxWords) {
        if (w > 0) out.push({ start: s, end: e, words: w, before, block });
        return;
      }
      wordChunks(sourceText, s, e, maxWords).forEach(([cs, ce, cw], j) =>
        out.push({ start: cs, end: ce, words: cw, before: j === 0 ? before : Boundary.Word, block }),
      );
    });
  });
  return out;
}

/** Split [start, end) after each match of `endPattern`, dropping the whitespace between pieces. */
function cutAt(src: string, start: number, end: number, endPattern: RegExp): [number, number][] {
  const piece = src.slice(start, end);
  const out: [number, number][] = [];
  let from = 0;
  for (const m of piece.matchAll(endPattern)) {
    const cut = m.index + m[0].length;
    const space = new RegExp(`^${CUT_SPACE}+`).exec(piece.slice(cut))?.[0].length ?? 0;
    if (cut > from) out.push([start + from, start + cut]);
    from = cut + space;
  }
  if (from < piece.length) out.push([start + from, end]);
  return out;
}

/** Consecutive runs of at most `maxWords` whitespace-delimited tokens. */
function wordChunks(src: string, start: number, end: number, maxWords: number): [number, number, number][] {
  const piece = src.slice(start, end);
  const tokens: [number, number][] = [];
  let last = 0;
  for (const m of piece.matchAll(CUT_SPACE_RUN)) {
    if (m.index > last) tokens.push([last, m.index]);
    last = m.index + m[0].length;
  }
  if (last < piece.length) tokens.push([last, piece.length]);
  const out: [number, number, number][] = [];
  for (let i = 0; i < tokens.length; i += maxWords) {
    const group = tokens.slice(i, i + maxWords);
    const s = start + group[0]![0];
    const e = start + group.at(-1)![1];
    out.push([s, e, countCanonicalWords(src.slice(s, e))]);
  }
  return out;
}

/**
 * Choose cut points: the fewest parts (greedy packing is optimal for that), then dynamic
 * programming over cuts to minimise imbalance plus boundary penalties.
 */
function partition(segments: Segment[], maxWords: number, spans: QuoteSpan[]): (readonly [number, number])[] {
  const n = segments.length;
  const prefix = [0];
  for (const s of segments) prefix.push(prefix.at(-1)! + s.words);
  const words = (from: number, to: number) => prefix[to]! - prefix[from]!;

  let parts = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && words(i, j + 1) <= maxWords) j++;
    i = j;
    parts++;
  }
  const target = prefix[n]! / parts;

  const cutCost = (at: number) => {
    const seg = segments[at]!;
    const pos = seg.start;
    const inside = spans.some((q) => q.start < pos && q.end > segments[at - 1]!.end);
    return CUT_PENALTY[seg.before] + (inside ? INSIDE_QUOTE_PENALTY : 0);
  };
  const partCost = (from: number, to: number) => ((words(from, to) - target) / target) ** 2;

  // best[k][j]: cheapest way to put segments [0, j) into k parts.
  const best: number[][] = Array.from({ length: parts + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const back: number[][] = Array.from({ length: parts + 1 }, () => new Array<number>(n + 1).fill(-1));
  best[0]![0] = 0;
  for (let k = 1; k <= parts; k++) {
    for (let j = 1; j <= n; j++) {
      for (let i = j - 1; i >= 0 && words(i, j) <= maxWords; i--) {
        const prev = best[k - 1]![i]!;
        if (prev === Infinity) continue; // only best[0][0] is finite at k = 0, so parts never start empty
        const cost = prev + partCost(i, j) + (i > 0 ? cutCost(i) : 0);
        if (cost < best[k]![j]!) {
          best[k]![j] = cost;
          back[k]![j] = i;
        }
      }
    }
  }
  const groups: [number, number][] = [];
  for (let k = parts, j = n; k > 0; k--) {
    const i = back[k]![j]!;
    groups.unshift([i, j]);
    j = i;
  }
  return groups;
}

/** Blocks for a part: whole paragraphs/headings, or the slice of a split paragraph; breaks between them kept. */
function partBlocks(blocks: Block[], text: TextBlock[], segs: Segment[], sourceText: string): Block[] {
  const out: Block[] = [];
  const byBlock = new Map<number, Segment[]>();
  for (const s of segs) byBlock.set(s.block, [...(byBlock.get(s.block) ?? []), s]);
  const textIndexOf = new Map(text.map((t, i) => [t.block, i]));
  let started = false;
  let pendingBreaks: Block[] = [];
  for (const b of blocks) {
    if (b.kind === "break") {
      if (started) pendingBreaks.push(b);
      continue;
    }
    const idx = textIndexOf.get(b as TextBlock["block"])!;
    const mine = byBlock.get(idx);
    if (!mine) {
      if (started && idx > segs.at(-1)!.block) break;
      continue;
    }
    if (started) out.push(...pendingBreaks);
    pendingBreaks = [];
    started = true;
    const t = text[idx]!;
    const s = mine[0]!.start;
    const e = mine.at(-1)!.end;
    const slice = sourceText.slice(s, e);
    out.push(s === t.start && e === t.end ? b : { ...b, text: slice });
  }
  return out;
}

/** Intersect quote spans with a part, re-based to the part's own offsets. */
function fragmentsFor(spans: QuoteSpan[], partStart: number, partEnd: number): QuoteFragment[] {
  return spans
    .filter((q) => q.start < partEnd && q.end > partStart)
    .map((q) => ({
      quoteId: q.id,
      start: Math.max(q.start, partStart) - partStart,
      end: Math.min(q.end, partEnd) - partStart,
      continuesFromPrevious: q.start < partStart,
      continuesIntoNext: q.end > partEnd,
    }));
}
