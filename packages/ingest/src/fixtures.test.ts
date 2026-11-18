import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { IngestedBook } from "./epub.js";
import {
  FixtureManifestSchema,
  excerptChapter,
  findChapter,
  ingestFixtureBook,
  loadFixtureManifest,
  readFixtureBook,
  type ChapterSelection,
  type ContinuitySelection,
  type FixtureManifest,
  type ShowcaseSelection,
} from "./fixtures.js";
import { MAX_PART_WORDS } from "./split.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = join(repoRoot, "fixtures/books");

let manifest: FixtureManifest;
const books = new Map<string, IngestedBook>();
const chapterSelections = (role: ChapterSelection["role"]) =>
  manifest.selections.filter((s): s is ChapterSelection => s.role === role);
const showcases = () => manifest.selections.filter((s): s is ShowcaseSelection => s.role === "dialogue-showcase");
const continuity = () => manifest.selections.filter((s): s is ContinuitySelection => s.role === "continuity");

beforeAll(async () => {
  manifest = await loadFixtureManifest(dir);
  for (const b of manifest.books) books.set(b.id, await ingestFixtureBook(dir, b));
}, 60_000);

describe("bundled books (Req 1.6)", () => {
  it("are pinned by size and SHA-256, and a changed file is refused", async () => {
    const book = manifest.books[0]!;
    await expect(readFixtureBook(dir, book)).resolves.toHaveLength(book.bytes);
    const tmp = await mkdtemp(join(tmpdir(), "mr-fixture-"));
    try {
      await copyFile(join(dir, book.file), join(tmp, book.file));
      const bytes = await readFile(join(tmp, book.file));
      const at = bytes.length - 100;
      bytes.writeUInt8(bytes.readUInt8(at) ^ 0xff, at); // flip one byte
      await writeFile(join(tmp, book.file), bytes);
      await expect(readFixtureBook(tmp, book)).rejects.toThrow(/does not match its pinned checksum/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("ingest with the expected titles, authors and chapter counts", () => {
    for (const b of manifest.books) {
      const book = books.get(b.id)!;
      expect(book.title).toBe(b.title);
      expect(book.author).toBe(b.author);
      expect(book.chapters).toHaveLength(b.chapterCount);
    }
  });

  it("the manifest rejects selections that point at unknown books", () => {
    const bad = { ...manifest, selections: [{ ...manifest.selections[0]!, book: "nope" }] };
    expect(FixtureManifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("selections", () => {
  it("include at least two demo stations, each a complete chapter that needs no split", () => {
    const stations = chapterSelections("demo-station");
    expect(stations.length).toBeGreaterThanOrEqual(2);
    expect(stations.map((s) => s.id)).toEqual(expect.arrayContaining(["tell-tale-heart", "dracula-ch1"]));
    for (const s of [...stations, ...chapterSelections("atmosphere")]) {
      const ch = findChapter(books.get(s.book)!, s.chapterTitle);
      expect(ch.wordCount, s.id).toBe(s.expectedWords);
      expect(ch.wordCount, s.id).toBeLessThanOrEqual(MAX_PART_WORDS);
      expect(ch.parts, s.id).toHaveLength(1);
      expect(ch.canonicalText.startsWith(s.startsWith), s.id).toBe(true);
      expect(ch.canonicalText.endsWith(s.endsWith), s.id).toBe(true);
    }
  });

  it("include a contiguous, unaltered dialogue excerpt with at least two speakers", () => {
    const [showcase] = showcases();
    expect(showcase).toBeDefined();
    const ch = findChapter(books.get(showcase!.book)!, showcase!.chapterTitle);
    const ex = excerptChapter(ch, showcase!.excerpt.from, showcase!.excerpt.to);

    // Contiguous and unaltered: an exact slice of the chapter, starting and ending on paragraph boundaries.
    expect(ex.sourceText).toBe(ch.sourceText.slice(ex.sourceStart, ex.sourceEnd));
    expect(ex.sourceStart === 0 || ch.sourceText.slice(ex.sourceStart - 2, ex.sourceStart) === "\n\n").toBe(true);
    expect(ex.sourceEnd === ch.sourceText.length || ch.sourceText.slice(ex.sourceEnd, ex.sourceEnd + 2) === "\n\n").toBe(true);
    expect(ex.wordCount).toBe(showcase!.expectedWords);

    // Actual dialogue, from the named speakers, verbatim in the source.
    expect((ex.sourceText.match(/“/g) ?? []).length).toBeGreaterThanOrEqual(10);
    for (const sp of showcase!.speakers) expect(ex.canonicalText, sp.name).toContain(sp.line);
    expect(showcase!.label).toMatch(/^Excerpt/);
  });

  it("include at least two chapters sharing characters, for continuity tests", () => {
    const [cont] = continuity();
    expect(cont).toBeDefined();
    const book = books.get(cont!.book)!;
    const chapters = cont!.chapterTitles.map((t) => findChapter(book, t));
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    for (const character of cont!.sharedCharacters) {
      for (const ch of chapters) {
        expect(
          character.mentions.some((m) => ch.canonicalText.includes(m)),
          `${character.name} in chapter ${ch.title}`,
        ).toBe(true);
      }
    }
  });

  it("excerpts fail loudly if a boundary sentence is missing or ambiguous", () => {
    const ch = findChapter(books.get("dracula")!, "II");
    expect(() => excerptChapter(ch, "No such sentence", "God keep me")).toThrow(/matches 0 paragraphs/);
    expect(() => excerptChapter(ch, "“", "God keep me, if only for the sake of those dear to me!")).toThrow(/matches \d+ paragraphs/);
  });
});

describe("attribution", () => {
  it("ATTRIBUTION.md credits every bundled book with its edition URL and revision", async () => {
    const text = await readFile(join(repoRoot, "ATTRIBUTION.md"), "utf8");
    for (const b of manifest.books) {
      expect(text, b.id).toContain(b.title);
      expect(text, b.id).toContain(b.author);
      expect(text, b.id).toContain(b.editionUrl);
      expect(text, b.id).toContain(b.editionRevision);
    }
    expect(text).toMatch(/CC0 1\.0/);
    expect(text).toMatch(/United States/);
  });
});
