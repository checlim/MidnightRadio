import { isCDATA, isTag, isText, type AnyNode, type Document, type Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import { IngestError } from "./errors.js";

/**
 * Decode an XML/XHTML file: BOM first, then the XML declaration's `encoding`, else UTF-8.
 * Invalid bytes become U+FFFD rather than failing the whole book.
 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf.subarray(3));
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  const head = buf.subarray(0, 200).toString("latin1");
  const label = /^<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1];
  if (label && WINDOWS_1252_LABELS.has(label.toLowerCase())) return decodeWindows1252(buf);
  if (label) {
    try {
      return new TextDecoder(label).decode(buf);
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(buf);
}

/** WHATWG treats all of these labels as windows-1252. */
const WINDOWS_1252_LABELS = new Set(["windows-1252", "cp1252", "x-cp1252", "iso-8859-1", "iso8859-1", "latin1", "l1", "us-ascii", "ascii", "iso_8859-1"]);

// Bytes 0x80–0x9F in windows-1252 (curly quotes, dashes, ellipsis…); undefined code points map to themselves.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/**
 * Decode windows-1252 ourselves: Node 24's TextDecoder decodes this label as ISO-8859-1, turning
 * the curly quotes at 0x93/0x94 into control characters, which would break quote extraction.
 */
function decodeWindows1252(buf: Buffer): string {
  let out = "";
  for (let i = 0; i < buf.length; i += 8192) {
    const codes = Array.from(buf.subarray(i, i + 8192), (b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b));
    out += String.fromCharCode(...codes);
  }
  return out;
}

/**
 * Entity declarations live in a DOCTYPE internal subset (`<!DOCTYPE x [ ... ]>`). We never resolve
 * them, but reject them outright so no expansion trick (XXE, billion laughs) can reach any parser.
 * Plain DOCTYPEs such as XHTML 1.1's are fine; the referenced DTD is never fetched.
 */
function assertNoEntityDeclarations(text: string, where: string): void {
  if (/<!ENTITY/i.test(text) || /<!DOCTYPE[^>[]*\[/i.test(text)) {
    throw new IngestError("unsafe_archive", `This EPUB was rejected as unsafe: ${where} declares custom XML entities.`);
  }
}

/** Parse an XML file (container.xml, OPF, NCX) with element names as written. */
export function parseXml(text: string, where: string): Document {
  assertNoEntityDeclarations(text, where);
  return parseDocument(text, { xmlMode: true });
}

/**
 * Parse an XHTML content document. HTML mode decodes the named entities EPUB 2 books use
 * (`&mdash;`, `&nbsp;`) and is lenient about markup errors; self-closing tags and CDATA keep
 * their XML meaning.
 */
export function parseXhtml(text: string, where: string): Document {
  assertNoEntityDeclarations(text, where);
  return parseDocument(text, {
    xmlMode: false,
    decodeEntities: true,
    recognizeSelfClosing: true,
    recognizeCDATA: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
  });
}

/** Element name without any namespace prefix (`opf:item` → `item`), lower-cased. */
export const localName = (el: Element): string => (el.name.includes(":") ? el.name.slice(el.name.indexOf(":") + 1) : el.name).toLowerCase();

/** Attribute by local name, ignoring any namespace prefix and case. */
export function attr(el: Element, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(el.attribs)) {
    const local = k.includes(":") ? k.slice(k.indexOf(":") + 1) : k;
    if (k.toLowerCase() === want || local.toLowerCase() === want) return v;
  }
  return undefined;
}

export const childElements = (node: AnyNode): Element[] =>
  "children" in node ? (node.children as AnyNode[]).filter(isTag) : [];

/** All descendant elements matching `pred`, in document order. */
export function findAll(node: AnyNode, pred: (el: Element) => boolean, out: Element[] = []): Element[] {
  for (const child of childElements(node)) {
    if (pred(child)) out.push(child);
    findAll(child, pred, out);
  }
  if (isCDATA(node)) for (const c of node.children) findAll(c, pred, out);
  return out;
}

export const findFirst = (node: AnyNode, pred: (el: Element) => boolean): Element | undefined => findAll(node, pred)[0];

/** Concatenated text of all descendants, whitespace runs folded to single spaces and trimmed. */
export function textOf(node: AnyNode): string {
  const parts: string[] = [];
  const walk = (n: AnyNode) => {
    if (isText(n)) parts.push(n.data);
    else if ("children" in n) for (const c of n.children as AnyNode[]) walk(c);
  };
  walk(node);
  return parts.join("").replace(/[ \t\n\r\f]+/g, " ").trim();
}

/** The `epub:type` tokens of an element, lower-cased. */
export const epubTypes = (el: Element): string[] =>
  (el.attribs["epub:type"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
