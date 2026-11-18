import { buildChapters, type Chapter, type SpineDocument } from "./chapters.js";
import { IngestError } from "./errors.js";
import { MATTER_TYPES, extractDocument } from "./extract.js";
import { Budget, DEFAULT_LIMITS, type IngestLimits } from "./limits.js";
import { XHTML_TYPES, parseContainer, parseNavDocument, parseNcx, parsePackage, type Reference, type TocEntry } from "./opf.js";
import { openArchive, type Archive } from "./zip.js";
import { decodeText, parseXhtml, parseXml } from "./xml.js";

export interface IngestedBook {
  title: string;
  author: string | undefined;
  language: string | undefined;
  chapters: Chapter[];
}

export interface IngestOptions {
  limits?: Partial<IngestLimits>;
  now?: () => number;
}

/** Landmark (EPUB 3) and guide (EPUB 2) types for whole documents that are not story text. */
const MATTER_REFERENCES = new Set([...MATTER_TYPES, "title-page", "copyright", "toc", "cover", "loi", "lot", "index", "colophon"]);
/** Where the story starts, if the book says so. */
const BODY_START = new Set(["bodymatter", "text", "start"]);

/**
 * Parse an EPUB into chapters with titles, story text and word counts (Req 1.1, 1.3).
 * Throws IngestError with a human-readable reason when the file can't be used (Req 1.2).
 * Never fetches anything: external references are ignored.
 */
export async function ingestEpub(bytes: Uint8Array, opts: IngestOptions = {}): Promise<IngestedBook> {
  const budget = new Budget({ ...DEFAULT_LIMITS, ...opts.limits }, opts.now);
  const archive = await openArchive(bytes, budget);
  try {
    return await readBook(archive, budget);
  } finally {
    archive.close();
  }
}

async function readBook(archive: Archive, budget: Budget): Promise<IngestedBook> {
  await checkMimetype(archive);
  await rejectDrm(archive);

  const container = await readText(archive, "META-INF/container.xml");
  if (container === undefined) throw new IngestError("malformed", "This EPUB is damaged: it has no META-INF/container.xml.");
  const opfPath = parseContainer(parseXml(container, "META-INF/container.xml"));
  const opfText = await readText(archive, opfPath);
  if (opfText === undefined) throw new IngestError("malformed", "This EPUB is damaged: its package document is missing.");
  const pkg = parsePackage(parseXml(opfText, opfPath), opfPath);

  let toc: TocEntry[] = [];
  let landmarks: Reference[] = [];
  if (pkg.nav) {
    const navText = await readText(archive, pkg.nav.path);
    if (navText !== undefined) ({ toc, landmarks } = parseNavDocument(parseXhtml(navText, pkg.nav.path), pkg.nav.path));
  }
  if (toc.length === 0 && pkg.ncx) {
    const ncxText = await readText(archive, pkg.ncx.path);
    if (ncxText !== undefined) toc = parseNcx(parseXml(ncxText, pkg.ncx.path), pkg.ncx.path);
  }

  const references = [...landmarks, ...pkg.guide];
  const matterPaths = new Set(references.filter((r) => MATTER_REFERENCES.has(r.type) && !r.fragment).map((r) => r.path));
  const bodyStart = references.find((r) => BODY_START.has(r.type))?.path;

  let spine = pkg.spine.filter((s) => s.linear && XHTML_TYPES.has(s.item.mediaType) && !s.item.properties.has("nav"));
  const startAt = bodyStart ? spine.findIndex((s) => s.item.path === bodyStart) : -1;
  if (startAt > 0) spine = spine.slice(startAt);

  const docs: SpineDocument[] = [];
  for (const { item } of spine) {
    budget.checkDeadline();
    if (matterPaths.has(item.path)) continue;
    const text = await readText(archive, item.path);
    if (text === undefined) continue; // listed but missing: skip rather than reject the book
    const extracted = extractDocument(parseXhtml(text, item.path));
    if (!extracted.matter) docs.push({ path: item.path, ...extracted });
  }

  const chapters = buildChapters(docs, toc);
  if (chapters.length === 0) {
    throw new IngestError("no_text", "This EPUB doesn't contain any readable story text. It may be image-only or empty.");
  }
  return { title: pkg.title, author: pkg.author, language: pkg.language, chapters };
}

async function readText(archive: Archive, name: string): Promise<string | undefined> {
  const buf = await archive.read(name);
  return buf === undefined ? undefined : decodeText(buf);
}

async function checkMimetype(archive: Archive): Promise<void> {
  const buf = await archive.read("mimetype");
  if (buf !== undefined && buf.toString("latin1").trim() !== "application/epub+zip") {
    throw new IngestError("not_epub", "This file isn't an EPUB: its type marker says it's something else.");
  }
}

/**
 * DRM shows up as rights files (Adobe ADEPT, Apple FairPlay, Readium LCP) or as encrypted content
 * in `encryption.xml`. Font obfuscation (IDPF, Adobe) is not DRM and is allowed.
 */
const FONT_OBFUSCATION = new Set(["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#rc"]);
async function rejectDrm(archive: Archive): Promise<void> {
  const drm = new IngestError("drm", "This EPUB is protected by DRM, so it can't be read. Only DRM-free EPUBs are supported.");
  for (const name of ["META-INF/rights.xml", "META-INF/sinf.xml", "META-INF/license.lcpl"]) {
    if (archive.has(name)) throw drm;
  }
  const enc = await readText(archive, "META-INF/encryption.xml");
  if (enc === undefined) return;
  const algorithms = [...enc.matchAll(/<(?:\w+:)?EncryptionMethod\b[^>]*\bAlgorithm\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.toLowerCase());
  if (algorithms.some((a) => !FONT_OBFUSCATION.has(a))) throw drm;
}
