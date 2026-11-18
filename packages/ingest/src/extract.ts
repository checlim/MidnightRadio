import { isCDATA, isTag, isText, type AnyNode, type Document, type Element } from "domhandler";
import { attr, epubTypes, localName } from "./xml.js";

export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  /** `hr`: an explicit break. `blank`: an empty paragraph, which may or may not mark a scene break (task 3.3 decides). */
  | { kind: "break"; marker: "hr" | "blank" };

export interface ExtractedDocument {
  blocks: Block[];
  /** Element id (and legacy `<a name>`) → index of the first block at or after it. */
  anchors: Map<string, number>;
  /** True if the document body is typed as front/back matter (cover, title page, TOC…). */
  matter: boolean;
}

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "center", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "footer", "form", "header", "hgroup", "html", "li", "main", "menu", "ol", "p",
  "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "caption", "ul", "figure",
]);

/** Never text: metadata, scripts, media. */
const SKIP_TAGS = new Set([
  "head", "script", "style", "template", "noscript", "img", "svg", "picture", "video", "audio", "source", "track",
  "object", "embed", "iframe", "canvas", "map", "area", "math", "input", "button", "select", "textarea", "nav",
]);

/** `epub:type` / `role` values whose whole subtree is not story text. */
const NON_STORY_TYPES = new Set([
  // front and back matter, navigation
  "toc", "landmarks", "page-list", "loi", "lot", "lov", "loa", "cover", "titlepage", "halftitlepage", "halftitle",
  "copyright-page", "imprint", "colophon", "index", "frontispiece", "seriespage",
  // notes
  "footnote", "footnotes", "endnote", "endnotes", "rearnote", "rearnotes", "note", "noteref",
  // page markers
  "pagebreak",
]);
const NON_STORY_ROLES = new Set([
  "doc-toc", "doc-pagelist", "doc-cover", "doc-colophon", "doc-index", "doc-footnote", "doc-endnote", "doc-endnotes",
  "doc-noteref", "doc-pagebreak",
]);

/** Document-level types that mark a whole file as not story text. */
export const MATTER_TYPES = new Set(["cover", "titlepage", "halftitlepage", "toc", "landmarks", "copyright-page", "imprint", "colophon", "index", "seriespage"]);

const HEADING = /^h([1-6])$/;
// Project Gutenberg wraps its licence and header in these; page numbers use class "pagenum".
const BOILERPLATE_IDS = /^pg-(header|footer|machine-header|start-separator|end-separator)$/i;
const BOILERPLATE_CLASS = /\b(pg-boilerplate|pagenum|pageno|page-number)\b/i;
const FOOTNOTE_CLASS = /\b(footnotes?|endnotes?)\b/i;
const NOTEREF_CLASS = /\b(fnanchor|noteref|footnote-?ref|fn-?ref)\b/i;
const NOTE_MARKER = /^\s*[[(]?\s*(\d{1,3}|[*†‡§¶]{1,3}|[a-z])\s*[\])]?\s*$/i;
const DROP_CAP_CLASS = /\b(drop-?cap|dropcap|initial|first-?letter|cap)\b/i;

const classOf = (el: Element) => el.attribs.class ?? "";

function isHidden(el: Element): boolean {
  if ("hidden" in el.attribs) return true;
  return /display\s*:\s*none/i.test(el.attribs.style ?? "");
}

function isNonStory(el: Element): boolean {
  if (epubTypes(el).some((t) => NON_STORY_TYPES.has(t))) return true;
  if ((el.attribs.role ?? "").toLowerCase().split(/\s+/).some((r) => NON_STORY_ROLES.has(r))) return true;
  const cls = classOf(el);
  if (BOILERPLATE_CLASS.test(cls) || BOILERPLATE_IDS.test(el.attribs.id ?? "")) return true;
  if (FOOTNOTE_CLASS.test(cls) && localName(el) !== "a" && localName(el) !== "sup") return true;
  return isNoteReference(el);
}

/**
 * A footnote marker in running text: `<sup><a href="#fn1">1</a></sup>`, `<a class="fnanchor"
 * href="#Footnote_1">[1]</a>`. Decided from markup and the marker's shape, never from words in
 * the prose.
 */
function isNoteReference(el: Element): boolean {
  const name = localName(el);
  if (name === "sup") {
    const links = el.children.filter(isTag).filter((c) => localName(c) === "a");
    return links.length > 0 && links.some((a) => isNoteLink(a, true)) && NOTE_MARKER.test(plainText(el));
  }
  return name === "a" && isNoteLink(el, false);
}

function isNoteLink(a: Element, insideSup: boolean): boolean {
  const href = attr(a, "href") ?? "";
  if (!href.includes("#")) return false;
  if (!NOTE_MARKER.test(plainText(a))) return false;
  if (insideSup || NOTEREF_CLASS.test(classOf(a))) return true;
  return /(foot)?note|fn/i.test(href.slice(href.indexOf("#") + 1));
}

function plainText(node: AnyNode): string {
  if (isText(node)) return node.data;
  if ("children" in node) return (node.children as AnyNode[]).map(plainText).join("");
  return "";
}

/** `<img class="drop-cap" alt="T">` stands for the first letter of the paragraph. */
function dropCapLetter(img: Element): string | undefined {
  const alt = (img.attribs.alt ?? "").trim();
  if (!/^\p{L}$/u.test(alt)) return undefined;
  const parent = img.parent && isTag(img.parent) ? img.parent : undefined;
  return DROP_CAP_CLASS.test(classOf(img)) || (parent && DROP_CAP_CLASS.test(classOf(parent))) ? alt : undefined;
}

/** A figure that holds an image: drop it whole, caption included. */
const isImageFigure = (el: Element): boolean =>
  localName(el) === "figure" && containsTag(el, (n) => n === "img" || n === "svg" || n === "picture");

function containsTag(el: Element, pred: (name: string) => boolean): boolean {
  return el.children.some((c) => isTag(c) && (pred(localName(c)) || containsTag(c, pred)));
}

/** Fold XML whitespace runs (not NBSP) the way a browser renders them. */
const foldWhitespace = (s: string) => s.replace(/[ \t\n\r\f]+/g, " ");

/**
 * Finish a paragraph's raw text: spaces around line breaks dropped, repeated breaks collapsed
 * (so a blank line only ever separates paragraphs), edges trimmed. Returns "" if nothing visible.
 */
function finishText(raw: string, preformatted = false): string {
  const text = preformatted
    ? raw.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").replace(/^\n+|\s+$/g, "")
    : raw
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .replace(/^[ \n\t]+|[ \n\t]+$/g, "");
  return /\S/.test(text) ? text : "";
}

export function extractDocument(doc: Document): ExtractedDocument {
  const blocks: Block[] = [];
  const anchors = new Map<string, number>();
  let buf = "";
  let sawBlankParagraph = false;
  let pre = 0;
  let inHeading = false;

  const flush = (fromParagraph = false) => {
    const text = finishText(buf, pre > 0);
    buf = "";
    if (text) blocks.push({ kind: "paragraph", text });
    else if (fromParagraph && sawBlankParagraph) blocks.push({ kind: "break", marker: "blank" });
  };

  const walk = (node: AnyNode): void => {
    if (isText(node)) {
      buf += pre > 0 ? node.data : foldWhitespace(node.data);
      return;
    }
    if (isCDATA(node)) {
      for (const c of node.children) walk(c);
      return;
    }
    if (!isTag(node)) return;
    const el = node;
    const name = localName(el);

    // A block element starts a new block: flush pending inline text first, so an id on a chapter
    // heading points at the heading rather than the paragraph before it.
    const blockish = !inHeading && (BLOCK_TAGS.has(name) || HEADING.test(name) || name === "pre" || name === "hr");
    if (blockish) flush();

    for (const key of ["id", "name"] as const) {
      const v = el.attribs[key];
      if (v && (key === "id" || name === "a") && !anchors.has(v)) anchors.set(v, blocks.length);
    }

    if (name === "img") {
      const letter = dropCapLetter(el);
      if (letter) buf += letter;
      return;
    }
    if (SKIP_TAGS.has(name) || isHidden(el) || isNonStory(el) || isImageFigure(el)) return;

    if (name === "br") {
      buf += "\n";
      return;
    }
    if (name === "wbr") return;
    if (name === "hr") {
      if (inHeading) return;
      flush();
      blocks.push({ kind: "break", marker: "hr" });
      return;
    }

    const heading = HEADING.exec(name);
    if (heading && !inHeading) {
      flush();
      inHeading = true;
      for (const c of el.children) walk(c);
      inHeading = false;
      const text = finishText(buf).replace(/\n/g, " ");
      buf = "";
      if (text) blocks.push({ kind: "heading", level: Number(heading[1]), text });
      return;
    }

    if (name === "pre" && !inHeading) {
      pre++;
      for (const c of el.children) walk(c);
      flush(); // while pre > 0, so indentation is kept
      pre--;
      return;
    }

    if (BLOCK_TAGS.has(name) && !inHeading) {
      flush();
      const isParagraph = name === "p" || name === "div";
      // An empty <p></p> or <p>&nbsp;</p> may be a scene gap; remember it for task 3.3.
      sawBlankParagraph = isParagraph && finishText(foldWhitespace(plainText(el))) === "" && !containsTag(el, (n) => n === "img");
      for (const c of el.children) walk(c);
      flush(isParagraph);
      sawBlankParagraph = false;
      return;
    }

    for (const c of el.children) walk(c); // inline: no separator, so <em>w</em>ord stays "word"
  };

  const body = findBody(doc);
  walk(body ?? doc);
  flush();

  const matter = body ? epubTypes(body).some((t) => MATTER_TYPES.has(t)) || (body.attribs.role ?? "") === "doc-cover" : false;
  return { blocks, anchors, matter };
}

function findBody(node: AnyNode): Element | undefined {
  if (isTag(node) && localName(node) === "body") return node;
  if ("children" in node) {
    for (const c of node.children as AnyNode[]) {
      const found = findBody(c);
      if (found) return found;
    }
  }
  return undefined;
}
