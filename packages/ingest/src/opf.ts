import type { Document, Element } from "domhandler";
import { IngestError } from "./errors.js";
import { resolveHref, type ResolvedHref } from "./paths.js";
import { attr, childElements, findAll, findFirst, localName, textOf } from "./xml.js";

export interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: Set<string>;
}

export interface SpineItem {
  item: ManifestItem;
  linear: boolean;
}

export interface Reference extends ResolvedHref {
  /** Lower-cased landmark/guide type, e.g. `cover`, `toc`, `bodymatter`, `text`. */
  type: string;
}

export interface PackageDoc {
  title: string;
  author: string | undefined;
  language: string | undefined;
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  /** EPUB 3 navigation document, if declared. */
  nav: ManifestItem | undefined;
  /** EPUB 2 NCX, if declared. */
  ncx: ManifestItem | undefined;
  /** EPUB 2 `<guide>` references. */
  guide: Reference[];
}

const malformed = (why: string) => new IngestError("malformed", `This EPUB is damaged: ${why}.`);

export const XHTML_TYPES = new Set(["application/xhtml+xml", "text/html", "application/xml"]);

/** `META-INF/container.xml` → path of the package (OPF) document. */
export function parseContainer(doc: Document): string {
  const rootfiles = findAll(doc, (el) => localName(el) === "rootfile");
  const opf =
    rootfiles.find((el) => attr(el, "media-type") === "application/oebps-package+xml") ?? rootfiles[0];
  const fullPath = opf && attr(opf, "full-path");
  const resolved = fullPath ? resolveHref("", fullPath) : undefined;
  if (!resolved) throw malformed("it doesn't say where its contents are (META-INF/container.xml)");
  return resolved.path;
}

export function parsePackage(doc: Document, opfPath: string): PackageDoc {
  const pkg = findFirst(doc, (el) => localName(el) === "package");
  if (!pkg) throw malformed("its package document is missing or unreadable");
  const section = (name: string) => childElements(pkg).find((el) => localName(el) === name);

  const metadata = section("metadata");
  const dc = (name: string) => (metadata ? findAll(metadata, (el) => localName(el) === name).map(textOf).filter(Boolean) : []);
  const title = dc("title")[0] ?? "Untitled";
  const creators = dc("creator");
  const language = dc("language")[0];

  const manifest = new Map<string, ManifestItem>();
  const manifestEl = section("manifest");
  if (!manifestEl) throw malformed("it has no list of contents (manifest)");
  for (const el of childElements(manifestEl).filter((e) => localName(e) === "item")) {
    const id = attr(el, "id");
    const href = attr(el, "href");
    const resolved = href ? resolveHref(opfPath, href) : undefined;
    if (!id || !resolved) continue; // external or invalid: never fetched
    manifest.set(id, {
      id,
      path: resolved.path,
      mediaType: (attr(el, "media-type") ?? "").toLowerCase(),
      properties: new Set((attr(el, "properties") ?? "").toLowerCase().split(/\s+/).filter(Boolean)),
    });
  }

  const spineEl = section("spine");
  if (!spineEl) throw malformed("it has no reading order (spine)");
  const spine: SpineItem[] = [];
  for (const el of childElements(spineEl).filter((e) => localName(e) === "itemref")) {
    const item = manifest.get(attr(el, "idref") ?? "");
    if (item) spine.push({ item, linear: (attr(el, "linear") ?? "yes").toLowerCase() !== "no" });
  }
  if (spine.length === 0) throw malformed("its reading order (spine) is empty");

  const nav = [...manifest.values()].find((m) => m.properties.has("nav"));
  const tocId = attr(spineEl, "toc");
  const ncx = (tocId ? manifest.get(tocId) : undefined) ?? [...manifest.values()].find((m) => m.mediaType === "application/x-dtbncx+xml");

  const guide: Reference[] = [];
  const guideEl = section("guide");
  if (guideEl) {
    for (const el of childElements(guideEl).filter((e) => localName(e) === "reference")) {
      const resolved = resolveHref(opfPath, attr(el, "href") ?? "");
      const type = (attr(el, "type") ?? "").toLowerCase();
      if (resolved && type) guide.push({ ...resolved, type });
    }
  }

  return { title, author: creators.length ? creators.join(", ") : undefined, language, manifest, spine, nav, ncx, guide };
}

export interface TocEntry extends ResolvedHref {
  label: string;
}

/** EPUB 3 nav document → flattened TOC (document order, all levels) and landmarks. */
export function parseNavDocument(doc: Document, navPath: string): { toc: TocEntry[]; landmarks: Reference[] } {
  const navs = findAll(doc, (el) => localName(el) === "nav");
  const typed = (t: string) => navs.find((n) => (n.attribs["epub:type"] ?? "").toLowerCase().split(/\s+/).includes(t));
  const tocNav = typed("toc") ?? navs[0];
  const toc: TocEntry[] = [];
  if (tocNav) {
    for (const a of findAll(tocNav, (el) => localName(el) === "a")) {
      const resolved = resolveHref(navPath, attr(a, "href") ?? "");
      const label = textOf(a);
      if (resolved && label) toc.push({ ...resolved, label });
    }
  }
  const landmarks: Reference[] = [];
  const lm = typed("landmarks");
  if (lm) {
    for (const a of findAll(lm, (el) => localName(el) === "a")) {
      const resolved = resolveHref(navPath, attr(a, "href") ?? "");
      const type = (a.attribs["epub:type"] ?? "").toLowerCase().trim();
      if (resolved && type) for (const t of type.split(/\s+/)) landmarks.push({ ...resolved, type: t });
    }
  }
  return { toc, landmarks };
}

/** EPUB 2 NCX → flattened TOC in document order. */
export function parseNcx(doc: Document, ncxPath: string): TocEntry[] {
  const toc: TocEntry[] = [];
  const walk = (el: Element) => {
    for (const child of childElements(el)) {
      if (localName(child) !== "navpoint") continue;
      const label = findFirst(child, (e) => localName(e) === "navlabel");
      const content = childElements(child).find((e) => localName(e) === "content");
      const resolved = content ? resolveHref(ncxPath, attr(content, "src") ?? "") : undefined;
      const text = label ? textOf(label) : "";
      if (resolved && text) toc.push({ ...resolved, label: text });
      walk(child);
    }
  };
  const navMap = findFirst(doc, (el) => localName(el) === "navmap");
  if (navMap) walk(navMap);
  return toc;
}
