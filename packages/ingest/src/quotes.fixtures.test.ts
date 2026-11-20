import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicaliseText, parseQuotes, type QuoteParse } from "@midnight-radio/core";
import { beforeAll, describe, expect, it } from "vitest";
import { ingestFixtureBook, loadFixtureManifest } from "./fixtures.js";

/**
 * Audit of the quote parser on the bundled books (design: "audit the demo fixtures"). Pins how
 * many chapters parse and how many quotations they hold, so a parser change that alters either is
 * deliberate. The two Poe chapters that fail closed are genuinely ambiguous: "The Gold-Bug" uses ”
 * as a cipher symbol, and "Thingum Bob" nests double quotes directly inside double quotes.
 */
const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), "fixtures/books");
const results = new Map<string, { title: string; parse: QuoteParse }[]>();

beforeAll(async () => {
  const manifest = await loadFixtureManifest(dir);
  for (const book of manifest.books) {
    const b = await ingestFixtureBook(dir, book);
    results.set(book.id, b.chapters.map((c) => ({ title: c.title, parse: parseQuotes(c.sourceText) })));
  }
}, 60_000);

const summary = (id: string) => {
  const r = results.get(id)!;
  return {
    chapters: r.length,
    ambiguous: r.filter((c) => c.parse.status === "ambiguous").map((c) => c.title),
    quotes: r.reduce((n, c) => n + c.parse.quotes.length, 0),
    overSeveralLines: r.reduce((n, c) => n + c.parse.quotes.filter((q) => q.pieces.length > 1).length, 0),
  };
};

describe("quote parser on the bundled books", () => {
  it("parses every chapter of Dracula", () => {
    expect(summary("dracula")).toEqual({ chapters: 28, ambiguous: [], quotes: 1367, overSeveralLines: 38 });
  });

  it("parses Poe except the two genuinely ambiguous stories", () => {
    expect(summary("poe-short-fiction")).toEqual({ chapters: 66, ambiguous: ["The Gold-Bug", "The Literary Life of Thingum Bob, Esq."], quotes: 2316, overSeveralLines: 73 });
  });

  it("finds the demo chapters' speech exactly", () => {
    const ch = (id: string, title: RegExp) => results.get(id)!.find((c) => title.test(c.title))!.parse;
    // Source text keeps the word joiners Standard Ebooks puts around dashes; compare canonical text.
    expect(ch("poe-short-fiction", /Telltale/).quotes.map((q) => canonicaliseText(q.text))).toEqual([
      "Who\u2019s there?",
      "It is nothing but the wind in the chimney\u2014it is only a mouse crossing the floor,",
      "It is merely a cricket which has made a single chirp.",
      "Villains!",
      expect.stringMatching(/^dissemble no more! I admit the deed!/),
    ]);
    const dracula2 = results.get("dracula")![1]!.parse;
    expect(dracula2.quotes.slice(0, 3).map((q) => q.text)).toEqual(["Welcome to my house! Enter freely and of your own will!", "Welcome to my house. Come freely. Go safely; and leave something of the happiness you bring!", "Count Dracula?"]);
    const letter = results.get("dracula")![0]!.parse.quotes.find((q) => q.text.startsWith("My Friend."))!;
    expect(letter.pieces).toHaveLength(3);
    expect(letter.text.endsWith("Your friend, Dracula.")).toBe(true);
  });
});
