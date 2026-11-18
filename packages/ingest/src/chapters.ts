import { NORMALISER_VERSION, canonicaliseText } from "@midnight-radio/core";
import type { Block, ExtractedDocument } from "./extract.js";
import type { TocEntry } from "./opf.js";

export interface SpineDocument extends ExtractedDocument {
  path: string;
}

export interface Chapter {
  /** 0-based position among the book's chapters. */
  idx: number;
  title: string;
  /** Story blocks, without the chapter's own leading heading(s). Breaks are kept for task 3.3. */
  blocks: Block[];
  /**
   * Extracted text: paragraphs and in-chapter headings joined by blank lines (breaks render as
   * nothing). Never typography-folded, so quote extraction can tell ’ from '.
   */
  sourceText: string;
  /** `canonicaliseText(sourceText)`: what adaptation and the splitter work on. */
  canonicalText: string;
  normaliserVersion: string;
  /** Whitespace-delimited tokens in `canonicalText`. */
  wordCount: number;
  /** Archive path of the document where the chapter starts. */
  href: string;
}

/** Untitled text before the first TOC entry becomes a chapter only if it is at least this long. */
export const MIN_LEADING_WORDS = 100;

interface Position {
  doc: number;
  block: number;
}

const before = (a: Position, b: Position) => a.doc < b.doc || (a.doc === b.doc && a.block < b.block);

export const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;

/**
 * Split the book into chapters. TOC entries (nav or NCX, all levels) mark chapter starts across
 * documents and anchors; without a usable TOC, each spine document is a chapter. Chapters without
 * story words (e.g. a "Part One" divider) are dropped.
 */
export function buildChapters(docs: SpineDocument[], toc: TocEntry[]): Chapter[] {
  const docIndex = new Map(docs.map((d, i) => [d.path, i]));
  const starts: { pos: Position; label: string }[] = [];
  for (const entry of toc) {
    const doc = docIndex.get(entry.path);
    if (doc === undefined) continue; // points at skipped matter or outside the spine
    const block = entry.fragment === undefined ? 0 : docs[doc]!.anchors.get(entry.fragment);
    if (block === undefined) continue;
    const pos = { doc, block };
    const last = starts.at(-1);
    if (last && !before(last.pos, pos)) continue; // out of order or duplicate: keep the first
    starts.push({ pos, label: entry.label.replace(/\s+/g, " ").trim() });
  }

  const raw: { title: string | undefined; blocks: Block[]; href: string; leading: boolean }[] = [];
  if (starts.length === 0) {
    docs.forEach((d) => raw.push({ title: undefined, blocks: d.blocks, href: d.path, leading: false }));
  } else {
    const first = starts[0]!.pos;
    if (first.doc > 0 || first.block > 0) {
      raw.push({ title: undefined, blocks: slice(docs, { doc: 0, block: 0 }, first), href: docs[0]!.path, leading: true });
    }
    starts.forEach((s, i) => {
      const end = starts[i + 1]?.pos ?? { doc: docs.length, block: 0 };
      raw.push({ title: s.label, blocks: slice(docs, s.pos, end), href: docs[s.pos.doc]!.path, leading: false });
    });
  }

  const chapters: Chapter[] = [];
  for (const r of raw) {
    const { headings, body } = splitLeadingHeadings(tidyBreaks(r.blocks));
    const sourceText = body
      .filter((b) => b.kind !== "break")
      .map((b) => (b as { text: string }).text)
      .join("\n\n");
    const canonicalText = canonicaliseText(sourceText);
    const wordCount = countWords(canonicalText);
    if (wordCount === 0 || (r.leading && wordCount < MIN_LEADING_WORDS)) continue;
    const title = r.title || headings.join(" — ") || `Chapter ${chapters.length + 1}`;
    chapters.push({
      idx: chapters.length,
      title,
      blocks: body,
      sourceText,
      canonicalText,
      normaliserVersion: NORMALISER_VERSION,
      wordCount,
      href: r.href,
    });
  }
  return chapters;
}

function slice(docs: SpineDocument[], from: Position, to: Position): Block[] {
  const out: Block[] = [];
  for (let d = from.doc; d < docs.length && (d < to.doc || (d === to.doc && to.block > 0)); d++) {
    const blocks = docs[d]!.blocks;
    const start = d === from.doc ? from.block : 0;
    const end = d === to.doc ? to.block : blocks.length;
    out.push(...blocks.slice(start, end));
  }
  return out;
}

/** Drop breaks at the edges and collapse runs, so a chapter never starts or ends on a break. */
function tidyBreaks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.kind === "break") {
      const prev = out.at(-1);
      if (!prev) continue;
      if (prev.kind === "break") {
        if (b.marker === "hr") out[out.length - 1] = b; // an explicit rule outranks a blank paragraph
        continue;
      }
    }
    out.push(b);
  }
  while (out.at(-1)?.kind === "break") out.pop();
  return out;
}

/** The chapter's own heading(s) come before any paragraph; later headings are story content. */
function splitLeadingHeadings(blocks: Block[]): { headings: string[]; body: Block[] } {
  let i = 0;
  const headings: string[] = [];
  while (i < blocks.length && blocks[i]!.kind !== "paragraph") {
    const b = blocks[i]!;
    if (b.kind === "heading") headings.push(b.text);
    i++;
  }
  return { headings, body: tidyBreaks(blocks.slice(i)) };
}
