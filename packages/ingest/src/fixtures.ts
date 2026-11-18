import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicaliseText } from "@midnight-radio/core";
import { z } from "zod";
import type { Chapter } from "./chapters.js";
import { ingestEpub, type IngestedBook } from "./epub.js";
import type { Block } from "./extract.js";
import { countCanonicalWords } from "./split.js";

/**
 * Bundled public-domain fixtures (Req 1.6): checksum-pinned EPUBs plus named selections (demo
 * stations, the dialogue showcase, continuity chapters). Used by tests and, later, demo seeding.
 */

const BookSchema = z.strictObject({
  id: z.string().min(1),
  file: z.string().regex(/^[\w.-]+\.epub$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  title: z.string().min(1),
  author: z.string().min(1),
  firstPublished: z.number().int(),
  edition: z.string().min(1),
  editionUrl: z.url(),
  editionRevision: z.string().min(1),
  editionReleased: z.iso.date(),
  textRights: z.string().min(1),
  editionRights: z.string().min(1),
  chapterCount: z.number().int().positive(),
});

const Base = { id: z.string().min(1), book: z.string().min(1) };
const Display = { displayTitle: z.string().min(1), label: z.string().min(1), expectedWords: z.number().int().positive() };

const SelectionSchema = z.discriminatedUnion("role", [
  z.strictObject({
    ...Base,
    ...Display,
    role: z.enum(["demo-station", "atmosphere"]),
    chapterTitle: z.string().min(1),
    startsWith: z.string().min(1),
    endsWith: z.string().min(1),
  }),
  z.strictObject({
    ...Base,
    ...Display,
    role: z.literal("dialogue-showcase"),
    chapterTitle: z.string().min(1),
    excerpt: z.strictObject({ from: z.string().min(1), to: z.string().min(1) }),
    speakers: z.array(z.strictObject({ name: z.string().min(1), line: z.string().min(1) })).min(2),
  }),
  z.strictObject({
    ...Base,
    role: z.literal("continuity"),
    chapterTitles: z.array(z.string().min(1)).min(2),
    sharedCharacters: z.array(z.strictObject({ name: z.string().min(1), mentions: z.array(z.string().min(1)).min(1) })).min(1),
  }),
]);

export const FixtureManifestSchema = z
  .strictObject({ version: z.literal(1), books: z.array(BookSchema).min(1), selections: z.array(SelectionSchema) })
  .superRefine((m, ctx) => {
    const ids = new Set(m.books.map((b) => b.id));
    m.selections.forEach((s, i) => {
      if (!ids.has(s.book)) ctx.addIssue({ code: "custom", path: ["selections", i, "book"], message: `unknown book "${s.book}"` });
    });
  });

export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;
export type FixtureBook = z.infer<typeof BookSchema>;
export type FixtureSelection = z.infer<typeof SelectionSchema>;
/** A whole chapter: a demo station or an atmosphere fixture. */
export type ChapterSelection = Extract<FixtureSelection, { role: "demo-station" | "atmosphere" }>;
export type ShowcaseSelection = Extract<FixtureSelection, { role: "dialogue-showcase" }>;
export type ContinuitySelection = Extract<FixtureSelection, { role: "continuity" }>;

export async function loadFixtureManifest(dir: string): Promise<FixtureManifest> {
  return FixtureManifestSchema.parse(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
}

/** Read a fixture EPUB, refusing it unless its size and SHA-256 match the manifest. */
export async function readFixtureBook(dir: string, book: FixtureBook): Promise<Buffer> {
  const bytes = await readFile(join(dir, book.file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== book.bytes || sha256 !== book.sha256) {
    throw new Error(`fixture ${book.file} does not match its pinned checksum (got ${bytes.length} bytes, sha256 ${sha256})`);
  }
  return bytes;
}

export async function ingestFixtureBook(dir: string, book: FixtureBook): Promise<IngestedBook> {
  return ingestEpub(await readFixtureBook(dir, book));
}

export interface Excerpt {
  blocks: Block[];
  /** Exact slice of the chapter's `sourceText`. */
  sourceText: string;
  sourceStart: number;
  sourceEnd: number;
  canonicalText: string;
  wordCount: number;
}

/**
 * A contiguous, paragraph-aligned excerpt: from the paragraph whose canonical text starts with
 * `from` to the paragraph whose canonical text ends with `to`. Each must match exactly one
 * paragraph, so the excerpt cannot silently drift if the edition changes.
 */
export function excerptChapter(chapter: Chapter, from: string, to: string): Excerpt {
  const text: { block: Block & { text: string }; start: number; end: number }[] = [];
  let offset = 0;
  for (const b of chapter.blocks) {
    if (b.kind === "break") continue;
    if (text.length > 0) offset += 2;
    text.push({ block: b, start: offset, end: offset + b.text.length });
    offset += b.text.length;
  }
  const only = (pred: (t: (typeof text)[number]) => boolean, what: string) => {
    const hits = text.map((t, i) => (pred(t) ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) throw new Error(`excerpt ${what} matches ${hits.length} paragraphs in "${chapter.title}"`);
    return hits[0]!;
  };
  const first = only((t) => canonicaliseText(t.block.text).startsWith(from), `start “${from}”`);
  const last = only((t) => canonicaliseText(t.block.text).endsWith(to), `end “${to}”`);
  if (last < first) throw new Error(`excerpt in "${chapter.title}" ends before it starts`);

  const sourceStart = text[first]!.start;
  const sourceEnd = text[last]!.end;
  const sourceText = chapter.sourceText.slice(sourceStart, sourceEnd);
  const firstBlock = chapter.blocks.indexOf(text[first]!.block);
  const lastBlock = chapter.blocks.indexOf(text[last]!.block);
  return {
    blocks: chapter.blocks.slice(firstBlock, lastBlock + 1),
    sourceText,
    sourceStart,
    sourceEnd,
    canonicalText: canonicaliseText(sourceText),
    wordCount: countCanonicalWords(sourceText),
  };
}

/** The chapter a selection refers to; its title must match exactly one chapter. */
export function findChapter(book: IngestedBook, title: string): Chapter {
  const hits = book.chapters.filter((c) => c.title === title);
  if (hits.length !== 1) throw new Error(`chapter "${title}" matches ${hits.length} chapters in "${book.title}"`);
  return hits[0]!;
}
