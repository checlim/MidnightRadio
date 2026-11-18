import { describe, expect, it } from "vitest";
import { ingestEpub } from "./epub.js";
import { IngestError } from "./errors.js";
import { buildEpub, type BookSpec } from "./test-support/build-epub.js";

const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");
const ingest = async (spec: BookSpec) => ingestEpub(await buildEpub(spec));
const only = async (body: string) => {
  const book = await ingest({ docs: [{ id: "c1", href: "c1.xhtml", body }] });
  expect(book.chapters).toHaveLength(1);
  return book.chapters[0]!;
};
const rejection = async (spec: BookSpec | Promise<Buffer>) => {
  try {
    await ingestEpub(spec instanceof Promise ? await spec : await buildEpub(spec));
  } catch (e) {
    if (e instanceof IngestError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected rejection");
};

describe("chapters, titles and word counts (Req 1.1)", () => {
  it("lists chapters in spine order with TOC titles and word counts, skipping the nav document", async () => {
    const book = await ingest({
      title: "The Fall of the House of Usher",
      author: "Edgar Allan Poe",
      docs: [
        { id: "c1", href: "text/ch1.xhtml", body: `<h1>I</h1><p>During the whole of a dull, dark, and soundless day</p>` },
        { id: "c2", href: "text/ch2.xhtml", body: `<h1>II</h1><p>Shaking off from my spirit what must have been a dream</p>` },
      ],
      toc: [
        { label: "Part I", href: "text/ch1.xhtml" },
        { label: "Part II", href: "text/ch2.xhtml" },
      ],
    });
    expect(book).toMatchObject({ title: "The Fall of the House of Usher", author: "Edgar Allan Poe", language: "en" });
    expect(book.chapters.map((c) => [c.idx, c.title, c.wordCount, c.href])).toEqual([
      [0, "Part I", 10, "OEBPS/text/ch1.xhtml"],
      [1, "Part II", 11, "OEBPS/text/ch2.xhtml"],
    ]);
    expect(book.chapters[0]!.text).toBe("During the whole of a dull, dark, and soundless day");
  });

  it("splits one file into several chapters at TOC anchors, and joins files into one chapter", async () => {
    const book = await ingest({
      docs: [
        { id: "a", href: "a.xhtml", body: `<h2 id="c1">CHAPTER I</h2><p>One one.</p><h2 id="c2">CHAPTER II</h2><p>Two two.</p>` },
        { id: "b", href: "b.xhtml", body: `<p>Still two.</p><h2 id="c3">CHAPTER III</h2><p>Three.</p>` },
      ],
      toc: [
        { label: "Chapter I", href: "a.xhtml#c1" },
        { label: "Chapter II", href: "a.xhtml#c2" },
        { label: "Chapter III", href: "b.xhtml#c3" },
      ],
    });
    expect(book.chapters.map((c) => [c.title, c.text])).toEqual([
      ["Chapter I", "One one."],
      ["Chapter II", "Two two.\n\nStill two."],
      ["Chapter III", "Three."],
    ]);
  });

  it("flattens nested TOCs and drops entries without story text (part dividers)", async () => {
    const book = await ingest({
      docs: [
        { id: "p1", href: "p1.xhtml", body: `<h1>PART ONE</h1>` },
        { id: "c1", href: "c1.xhtml", body: `<h2>I</h2><p>First chapter text.</p>` },
      ],
      toc: [{ label: "Part One", href: "p1.xhtml", children: [{ label: "Chapter 1", href: "c1.xhtml" }] }],
    });
    expect(book.chapters.map((c) => c.title)).toEqual(["Chapter 1"]);
  });

  it("keeps later headings as story content but removes the chapter's own heading", async () => {
    const ch = await only(`<h1>CHAPTER I</h1><h2>JONATHAN HARKER'S JOURNAL</h2><p>3 May. Bistritz.</p><h3>Later</h3><p>More.</p>`);
    expect(ch.title).toBe("CHAPTER I — JONATHAN HARKER'S JOURNAL");
    expect(ch.text).toBe("3 May. Bistritz.\n\nLater\n\nMore.");
  });

  it("falls back to one chapter per document, titled by heading or position, when there is no TOC", async () => {
    const book = await ingest({
      docs: [
        { id: "a", href: "a.xhtml", body: `<h1>The Tell-Tale Heart</h1><p>True!</p>` },
        { id: "b", href: "b.xhtml", body: `<p>Nervous, very dreadfully nervous.</p>` },
      ],
    });
    expect(book.chapters.map((c) => c.title)).toEqual(["The Tell-Tale Heart", "Chapter 2"]);
  });

  it("reads EPUB 2 books through the NCX and guide", async () => {
    const book = await ingest({
      docs: [
        { id: "cover", href: "cover.xhtml", body: `<p>THE COVER</p>` },
        { id: "c1", href: "c1.xhtml", body: `<p>Chapter one text.</p>` },
      ],
      ncx: [{ label: "One", href: "c1.xhtml" }],
      guide: [{ type: "cover", href: "cover.xhtml" }],
    });
    expect(book.chapters.map((c) => [c.title, c.text])).toEqual([["One", "Chapter one text."]]);
  });

  it("only turns untitled leading text into a chapter if it is substantial", async () => {
    const short = await ingest({
      docs: [
        { id: "t", href: "t.xhtml", body: `<p>DRACULA by Bram Stoker</p>` },
        { id: "c1", href: "c1.xhtml", body: `<p>Story.</p>` },
      ],
      toc: [{ label: "Chapter 1", href: "c1.xhtml" }],
    });
    expect(short.chapters.map((c) => c.title)).toEqual(["Chapter 1"]);
    const long = await ingest({
      docs: [
        { id: "p", href: "p.xhtml", body: `<h1>Prologue</h1><p>${words(120)}</p>` },
        { id: "c1", href: "c1.xhtml", body: `<p>Story.</p>` },
      ],
      toc: [{ label: "Chapter 1", href: "c1.xhtml" }],
    });
    expect(long.chapters.map((c) => c.title)).toEqual(["Prologue", "Chapter 1"]);
  });
});

describe("inline-safe text extraction (Req 1.3)", () => {
  it("joins inline tags without adding or removing spaces", async () => {
    const ch = await only(`<p><em>w</em>ord and <span class="x">two</span> <i>three</i>, <b>f</b><strong>our</strong>.</p>`);
    expect(ch.text).toBe("word and two three, four.");
  });

  it("keeps drop caps attached to their word, whether text or image", async () => {
    expect((await only(`<p><span class="dropcap">T</span>RUE!—nervous</p>`)).text).toBe("TRUE!—nervous");
    expect((await only(`<p><img class="drop-cap" src="t.png" alt="T"/>he night</p>`)).text).toBe("The night");
    expect((await only(`<p><span class="initial"><img src="t.png" alt="I"/></span>t was</p>`)).text).toBe("It was");
  });

  it("folds source whitespace like a browser but never deletes a word break; keeps NBSP", async () => {
    const ch = await only(`<p>
      It was
        a\tdark
      night,&nbsp;and</p>`);
    expect(ch.text).toBe("It was a dark night,\u00a0and");
  });

  it("separates blocks and keeps <br> as a line break inside a paragraph", async () => {
    const ch = await only(`<div><p>One.</p><p>Two</p></div><blockquote>Three<br/>  four<br/><br/>five</blockquote><ul><li>a</li><li>b</li></ul>`);
    expect(ch.text).toBe("One.\n\nTwo\n\nThree\nfour\nfive\n\na\n\nb");
  });

  it("decodes XHTML named entities and CDATA", async () => {
    expect((await only(`<p>Usher&mdash;the &ldquo;house&rdquo; &amp; <![CDATA[a <tarn>]]></p>`)).text).toBe("Usher—the “house” & a <tarn>");
  });

  it("records <hr> and empty paragraphs as breaks without text", async () => {
    const ch = await only(`<p>Before.</p><hr/><p>After.</p><p>&nbsp;</p><p>Later.</p>`);
    expect(ch.blocks).toEqual([
      { kind: "paragraph", text: "Before." },
      { kind: "break", marker: "hr" },
      { kind: "paragraph", text: "After." },
      { kind: "break", marker: "blank" },
      { kind: "paragraph", text: "Later." },
    ]);
    expect(ch.text).toBe("Before.\n\nAfter.\n\nLater.");
  });

  it("preserves whitespace inside <pre>", async () => {
    expect((await only(`<pre>a   b\n  c</pre>`)).text).toBe("a   b\n  c");
  });
});

describe("stripping non-story content (Req 1.3)", () => {
  it("removes footnote markers and footnote bodies, but not prose that mentions footnotes", async () => {
    const ch = await only(
      `<p>He spoke<sup><a href="#fn1">1</a></sup> and left<a class="fnanchor" href="#Footnote_2">[2]</a>.` +
        ` See<a epub:type="noteref" href="notes.xhtml#n3">3</a> it.</p>` +
        `<p>The word footnote appears here, and a <a href="#ch2">link to chapter 2</a>.</p>` +
        `<aside epub:type="footnote" id="fn1"><p>1. A note.</p></aside>` +
        `<div class="footnote"><p>[2] Another note.</p></div>`,
    );
    expect(ch.text).toBe("He spoke and left. See it.\n\nThe word footnote appears here, and a link to chapter 2.");
  });

  it("removes images and image figures with their captions, keeping text-only figures", async () => {
    const ch = await only(
      `<p>Before <img src="x.png" alt="A picture"/>after.</p>` +
        `<figure><img src="y.png" alt=""/><figcaption>The castle</figcaption></figure>` +
        `<figure><blockquote>A verse</blockquote></figure><svg><text>svg text</text></svg>`,
    );
    expect(ch.text).toBe("Before after.\n\nA verse");
  });

  it("removes page numbers, Project Gutenberg boilerplate, hidden and scripted content", async () => {
    const ch = await only(
      `<section id="pg-header"><p>The Project Gutenberg eBook of Dracula</p></section>` +
        `<p>It was<span class="pagenum"><a id="Page_12">[Pg 12]</a></span> late.<span epub:type="pagebreak" title="13">13</span></p>` +
        `<p hidden="">secret</p><p style="display: none">gone</p><script>alert(1)</script>` +
        `<section id="pg-footer"><p>*** END OF THE PROJECT GUTENBERG EBOOK ***</p></section>`,
    );
    expect(ch.text).toBe("It was late.");
  });

  it("skips front matter by landmarks, guide, linear=no and body type, and starts at bodymatter", async () => {
    const book = await ingest({
      docs: [
        { id: "cover", href: "cover.xhtml", body: `<p>${words(200, "cover")}</p>` },
        { id: "title", href: "title.xhtml", body: `<p>${words(200, "title")}</p>`, bodyAttrs: `epub:type="titlepage"` },
        { id: "copy", href: "copy.xhtml", body: `<p>${words(200, "copyright")}</p>`, linear: false },
        { id: "toc", href: "toc.xhtml", body: `<p>${words(200, "contents")}</p>` },
        { id: "c1", href: "c1.xhtml", body: `<section epub:type="halftitlepage"><p>HALF TITLE</p></section><p>Story begins.</p>` },
      ],
      landmarks: [
        { type: "cover", href: "cover.xhtml" },
        { type: "toc", href: "toc.xhtml" },
        { type: "bodymatter", href: "c1.xhtml" },
      ],
    });
    expect(book.chapters.map((c) => c.text)).toEqual(["Story begins."]);
  });

  it("keeps ordinary prose that contains words like 'contents' or 'cover'", async () => {
    expect((await only(`<p>She read the table of contents under the cover of night.</p>`)).text).toBe(
      "She read the table of contents under the cover of night.",
    );
  });
});

describe("rejections (Req 1.2)", () => {
  it("rejects DRM-protected books but allows font obfuscation", async () => {
    const adept = await rejection({ docs: [{ id: "c", href: "c.xhtml", body: "<p>x</p>" }], extraFiles: { "META-INF/rights.xml": "<rights/>" } });
    expect(adept.code).toBe("drm");
    const enc = (alg: string) =>
      `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${alg}"/><enc:CipherData><enc:CipherReference URI="OEBPS/c.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`;
    expect((await rejection({ docs: [{ id: "c", href: "c.xhtml", body: "<p>x</p>" }], extraFiles: { "META-INF/encryption.xml": enc("http://www.w3.org/2001/04/xmlenc#aes128-cbc") } })).code).toBe("drm");
    const fonts = await ingest({ docs: [{ id: "c", href: "c.xhtml", body: "<p>Readable.</p>" }], extraFiles: { "META-INF/encryption.xml": enc("http://www.idpf.org/2008/embedding") } });
    expect(fonts.chapters[0]!.text).toBe("Readable.");
  });

  it("rejects files that are not EPUBs, damaged EPUBs and EPUBs without text, with specific reasons", async () => {
    expect(await rejection(Promise.resolve(Buffer.from("%PDF-1.7 not a zip")))).toMatchObject({ code: "not_epub" });
    expect(await rejection({ docs: [{ id: "c", href: "c.xhtml", body: "<p>x</p>" }], mimetype: "application/zip" })).toMatchObject({ code: "not_epub" });
    const { zip } = await import("./test-support/build-epub.js");
    expect(await rejection(zip({ "OEBPS/c.xhtml": "<p>x</p>" }))).toMatchObject({ code: "malformed", message: expect.stringContaining("container.xml") });
    expect(await rejection({ docs: [{ id: "c", href: "c.xhtml", body: `<img src="page1.png"/>` }] })).toMatchObject({
      code: "no_text",
      message: expect.stringContaining("doesn't contain any readable story text"),
    });
  });

  it("rejects files over the size limit before reading them", async () => {
    const bytes = await buildEpub({ docs: [{ id: "c", href: "c.xhtml", body: "<p>x</p>" }] });
    await expect(ingestEpub(bytes, { limits: { maxEpubBytes: bytes.length - 1 } })).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects XML that declares entities, but accepts a plain XHTML 1.1 DOCTYPE without fetching it", async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE html [<!ENTITY x SYSTEM "file:///etc/passwd">]><html xmlns="http://www.w3.org/1999/xhtml"><body><p>&x;</p></body></html>`;
    expect(await rejection({ docs: [{ id: "c", href: "c.xhtml", body: xxe }] })).toMatchObject({ code: "unsafe_archive" });
    const epub2 = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>Fine&nbsp;text.</p></body></html>`;
    expect((await only(epub2)).text).toBe("Fine\u00a0text.");
  });
});

describe("encodings", () => {
  it("honours the XML declaration's encoding and UTF-16 byte-order marks", async () => {
    const latin = Buffer.concat([Buffer.from(`<?xml version="1.0" encoding="windows-1252"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>caf`), Buffer.from([0xe9, 0x20, 0x93, 0x71, 0x94]), Buffer.from(`</p></body></html>`)]);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<html xmlns="http://www.w3.org/1999/xhtml"><body><p>naïve</p></body></html>`, "utf16le")]);
    const { zip } = await import("./test-support/build-epub.js");
    const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>E</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`;
    const container = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    const book = await ingestEpub(await zip({ "META-INF/container.xml": container, "content.opf": opf, "a.xhtml": latin, "b.xhtml": utf16 }));
    expect(book.chapters.map((c) => c.text)).toEqual(["café “q”", "naïve"]);
  });
});
