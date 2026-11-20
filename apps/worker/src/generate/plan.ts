import { createHash } from "node:crypto";
import { parseQuotes, quoteUnitsForPart, type QuoteParse, type QuoteUnit } from "@midnight-radio/core";
import { splitChapter, type Chapter, type ChapterPart, type IngestedBook } from "@midnight-radio/ingest";

/**
 * What one generation run covers: every adaptation unit of the book (a chapter, or a part of a
 * long chapter), numbered as episodes in book order. Pure, so a rerun on the same EPUB plans the
 * same ids and resumes where it stopped.
 */

export interface PlannedEpisode {
  /** `chapters.id`. */
  chapterId: string;
  /** Station id and episode folder name. */
  stationId: string;
  /** 1-based over the whole book, in reading order. */
  episodeNumber: number;
  /** 1-based chapter number, as `--chapters` counts. */
  chapterNumber: number;
  title: string;
  chapter: Chapter;
  part: ChapterPart;
  quoteParse: QuoteParse;
  /** The part's quotations, for the fidelity gate. */
  quotes: QuoteUnit[];
}

export interface BookPlan {
  bookId: string;
  sourceHash: string;
  title: string;
  author: string | null;
  episodes: PlannedEpisode[];
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Lower-case words joined by `-`, at most `max` characters. */
export function slug(text: string, max = 40): string {
  const s = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s || "book";
}

/** Station id of a book's episode: title slug, a short hash of the EPUB, and the episode number. */
export const stationIdFor = (title: string, sourceHash: string, episodeNumber: number) => `${slug(title)}-${sourceHash.slice(0, 6)}-e${episodeNumber}`;

export function planBook(book: IngestedBook, epubBytes: Uint8Array): BookPlan {
  const sourceHash = sha256Hex(epubBytes);
  const bookId = `bk-${sourceHash.slice(0, 16)}`;
  const episodes: PlannedEpisode[] = [];
  for (const chapter of book.chapters) {
    const quoteParse = parseQuotes(chapter.sourceText);
    // Long chapters are cut again with the quotation spans, so no quotation is split mid-way.
    const parts =
      chapter.parts.length > 1 ? splitChapter(chapter.blocks, chapter.sourceText, { quoteSpans: quoteParse.quotes.map((q) => ({ id: q.id, start: q.start, end: q.end })) }) : chapter.parts;
    for (const part of parts) {
      const episodeNumber = episodes.length + 1;
      episodes.push({
        chapterId: `${bookId}-c${chapter.idx + 1}${part.partCount > 1 ? `-p${part.part}` : ""}`,
        stationId: stationIdFor(book.title, sourceHash, episodeNumber),
        episodeNumber,
        chapterNumber: chapter.idx + 1,
        title: part.label ? `${chapter.title} (${part.label})` : chapter.title,
        chapter,
        part,
        quoteParse,
        quotes: quoteUnitsForPart(quoteParse, chapter.sourceText, part.sourceStart, part.sourceEnd),
      });
    }
  }
  return { bookId, sourceHash, title: book.title, author: book.author?.trim() || null, episodes };
}

/**
 * Parse `--chapters`: "all", or 1-based chapter numbers and ranges such as "1,3-5". Returns the
 * selected chapter numbers, or throws with a message naming the problem.
 */
export function selectChapters(spec: string, chapterCount: number): Set<number> {
  const all = new Set(Array.from({ length: chapterCount }, (_, i) => i + 1));
  if (spec.trim().toLowerCase() === "all") return all;
  const picked = new Set<number>();
  for (const raw of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(raw);
    if (!m) throw new Error(`--chapters: "${raw.trim()}" is not a chapter number or range (e.g. 1,3-5 or all)`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from || to > chapterCount) throw new Error(`--chapters: ${raw.trim()} is outside 1–${chapterCount}`);
    for (let n = from; n <= to; n++) picked.add(n);
  }
  return picked;
}
