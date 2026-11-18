import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestEpub, type IngestOptions } from "./epub.js";
import { IngestError } from "./errors.js";
import { DEFAULT_LIMITS } from "./limits.js";
import { buildEpub, xhtml, zip } from "./test-support/build-epub.js";
import { rawZip, type RawEntry } from "./test-support/raw-zip.js";

const CONTAINER = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const opf = (items: string[]) =>
  `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest>${items
    .map((h, i) => `<item id="i${i}" href="${h}" media-type="application/xhtml+xml"/>`)
    .join("")}</manifest><spine>${items.map((_, i) => `<itemref idref="i${i}"/>`).join("")}</spine></package>`;

/** A valid book (mimetype, container, OPF, one chapter) plus extra raw entries. */
const book = (extra: RawEntry[], chapter: Partial<RawEntry> = {}): Buffer =>
  rawZip([
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: CONTAINER },
    { name: "content.opf", data: opf(["c.xhtml"]) },
    { name: "c.xhtml", data: xhtml("<p>Story.</p>"), ...chapter },
    ...extra,
  ]);

async function reject(bytes: Buffer, opts?: IngestOptions) {
  try {
    await ingestEpub(bytes, opts);
  } catch (e) {
    if (e instanceof IngestError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected rejection");
}

describe("raw ZIP helper", () => {
  it("produces archives the reader accepts", async () => {
    expect((await ingestEpub(book([]))).chapters[0]!.sourceText).toBe("Story.");
  });
});

describe("hostile archives", () => {
  it.each([
    ["../evil.xhtml"],
    ["a/../../evil.xhtml"],
    ["/etc/passwd"],
    ["C:/Windows/evil.xhtml"],
    ["a\\..\\evil.xhtml"],
    ["./c.xhtml"],
  ])("rejects the path %j", async (name) => {
    expect(await reject(book([{ name, data: "x" }]))).toMatchObject({
      code: "unsafe_archive",
      message: expect.stringContaining("points outside the book"),
    });
  });

  it("rejects symbolic links", async () => {
    expect(await reject(book([{ name: "link", data: "/etc/passwd", unixMode: 0o120777 }]))).toMatchObject({
      code: "unsafe_archive",
      message: expect.stringContaining("symbolic link"),
    });
  });

  it("rejects archives with too many entries", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `img/${i}.png`, data: "x" }));
    expect(await reject(book(many), { limits: { maxEntries: 20 } })).toMatchObject({ code: "unsafe_archive" });
  });

  it("rejects a highly compressible text file (ZIP bomb by ratio) without inflating it", async () => {
    const bomb = xhtml(`<p>${"a".repeat(4 * 1024 * 1024)}</p>`); // ~4 MiB of one letter deflates to a few KB
    expect(await reject(book([], { data: bomb }))).toMatchObject({ code: "unsafe_archive", message: expect.stringContaining("expands suspiciously") });
  });

  it("rejects an entry that inflates beyond its declared size", async () => {
    const lie = book([], { data: xhtml(`<p>${"story ".repeat(5_000)}</p>`), declaredSize: 200 });
    expect(await reject(lie)).toMatchObject({ code: "unsafe_archive", message: expect.stringContaining("declared size") });
  });

  it("rejects single text files and totals over the inflation limits", async () => {
    const big = book([], { data: xhtml(`<p>${"word ".repeat(3_000)}</p>`) });
    expect(await reject(big, { limits: { maxEntryBytes: 4_000 } })).toMatchObject({ code: "unsafe_archive" });
    expect(await reject(big, { limits: { maxTotalInflatedBytes: 4_000 } })).toMatchObject({ code: "unsafe_archive" });
  });

  it("never inflates images or other non-text entries, whatever their size", async () => {
    const hugeImage = { name: "img/cover.png", data: Buffer.alloc(8 * 1024 * 1024), declaredSize: 8 * 1024 * 1024 };
    const ok = await ingestEpub(book([hugeImage]), { limits: { maxTotalInflatedBytes: 64 * 1024 } });
    expect(ok.chapters[0]!.sourceText).toBe("Story.");
  });

  it("treats encrypted ZIP entries as DRM", async () => {
    expect(await reject(book([], { flags: 0x1 }))).toMatchObject({ code: "drm" });
  });

  it("rejects duplicate entry names", async () => {
    expect(await reject(book([{ name: "c.xhtml", data: "<p>other</p>" }]))).toMatchObject({ code: "malformed" });
  });

  it("gives up with a timeout when parsing runs past the deadline", async () => {
    let t = 0;
    const bytes = await buildEpub({ docs: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, href: `c${i}.xhtml`, body: `<p>Chapter ${i}.</p>` })) });
    expect(await reject(bytes, { limits: { deadlineMs: 1_000 }, now: () => (t += 150) })).toMatchObject({ code: "timeout" });
  });
});

describe("size limit (Req 1.1)", () => {
  it("rejects files over 20 MB before parsing anything", async () => {
    expect(DEFAULT_LIMITS.maxEpubBytes).toBe(20 * 1024 * 1024);
    const tooBig = Buffer.alloc(DEFAULT_LIMITS.maxEpubBytes + 1);
    expect(await reject(tooBig)).toEqual({ code: "too_large", message: "This file is larger than the 20 MB limit." });
  });
});

describe("damaged EPUBs", () => {
  const files = (opfText: string) => ({ "META-INF/container.xml": CONTAINER, "content.opf": opfText, "c.xhtml": xhtml("<p>x</p>") });

  it.each([
    ["no package document", { "META-INF/container.xml": CONTAINER }, "package document is missing"],
    ["no manifest", files(`<package xmlns="http://www.idpf.org/2007/opf"><metadata/><spine/></package>`), "no list of contents"],
    ["no spine", files(`<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest/></package>`), "no reading order"],
    [
      "empty spine",
      files(`<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest><item id="a" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine/></package>`),
      "reading order (spine) is empty",
    ],
    ["container without a rootfile", { "META-INF/container.xml": `<container><rootfiles/></container>` }, "container.xml"],
  ])("rejects a book with %s", async (_label, contents, reason) => {
    expect(await reject(await zip(contents as Record<string, string>))).toMatchObject({ code: "malformed", message: expect.stringContaining(reason) });
  });

  it("rejects a truncated ZIP file", async () => {
    const whole = book([]);
    expect(await reject(whole.subarray(0, whole.length - 30))).toMatchObject({ code: "not_epub" });
  });
});

describe("external resources are never fetched", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ignores remote and data: references in the OPF, nav and content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const remoteOpf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest>
      <item id="r" href="https://example.com/chapter.xhtml" media-type="application/xhtml+xml"/>
      <item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    </manifest><spine><itemref idref="r"/><itemref idref="c"/></spine></package>`;
    const nav = xhtml(`<nav epub:type="toc"><ol><li><a href="https://example.com/x.xhtml">Remote</a></li><li><a href="c.xhtml">Local</a></li></ol></nav>`);
    const content = xhtml(`<link rel="stylesheet" href="https://example.com/s.css"/><p>Local <img src="https://example.com/i.png"/>story <a href="https://example.com">link</a>.</p><img src="data:image/png;base64,AAAA"/>`);
    const book = await ingestEpub(await zip({ "META-INF/container.xml": CONTAINER, "content.opf": remoteOpf, "nav.xhtml": nav, "c.xhtml": content }));
    expect(book.chapters.map((c) => [c.title, c.sourceText])).toEqual([["Local", "Local story link."]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("has no networking code in the ingest package", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)));
    const files = readdirSync(src).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const f of files) {
      const code = readFileSync(join(src, f), "utf8");
      expect(code, f).not.toMatch(/from\s+["'](node:)?(http|https|net|tls|dgram|dns|http2)["']|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
    }
  });
});
