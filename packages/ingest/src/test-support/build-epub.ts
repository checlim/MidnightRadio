import { ZipFile } from "yazl";

export interface DocSpec {
  id: string;
  /** Path relative to the OPF directory (`OEBPS/`). */
  href: string;
  /** Inner HTML of `<body>`, or a full document if it starts with `<?xml` or `<html`. */
  body: string;
  linear?: boolean;
  bodyAttrs?: string;
  inSpine?: boolean;
}

export interface BookSpec {
  title?: string;
  author?: string;
  docs: DocSpec[];
  /** EPUB 3 nav TOC entries; omit for no nav document. */
  toc?: { label: string; href: string; children?: { label: string; href: string }[] }[];
  landmarks?: { type: string; href: string }[];
  /** EPUB 2 NCX entries (used instead of or as well as `toc`). */
  ncx?: { label: string; href: string }[];
  guide?: { type: string; href: string }[];
  /** Extra raw archive entries, e.g. META-INF/encryption.xml. */
  extraFiles?: Record<string, string | Buffer>;
  /** false omits the mimetype entry; a string overrides it. */
  mimetype?: string | false;
}

export const xhtml = (body: string, bodyAttrs = "") =>
  body.startsWith("<?xml") || body.startsWith("<html")
    ? body
    : `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>t</title></head>
<body${bodyAttrs ? ` ${bodyAttrs}` : ""}>${body}</body>
</html>`;

export function zip(files: Record<string, string | Buffer>, mimetype: string | false = "application/epub+zip"): Promise<Buffer> {
  const z = new ZipFile();
  if (mimetype !== false) z.addBuffer(Buffer.from(mimetype), "mimetype", { compress: false });
  for (const [name, content] of Object.entries(files)) z.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
  z.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    z.outputStream.on("data", (c: Buffer) => chunks.push(c));
    z.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    z.outputStream.on("error", reject);
  });
}

export function buildEpub(spec: BookSpec): Promise<Buffer> {
  const files: Record<string, string | Buffer> = {
    "META-INF/container.xml": `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  };
  const manifest: string[] = [];
  const spine: string[] = [];
  for (const d of spec.docs) {
    files[`OEBPS/${d.href}`] = xhtml(d.body, d.bodyAttrs);
    manifest.push(`<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`);
    if (d.inSpine !== false) spine.push(`<itemref idref="${d.id}"${d.linear === false ? ' linear="no"' : ""}/>`);
  }
  if (spec.toc || spec.landmarks) {
    const li = (e: { label: string; href: string; children?: { label: string; href: string }[] }): string =>
      `<li><a href="${e.href}">${e.label}</a>${e.children ? `<ol>${e.children.map(li).join("")}</ol>` : ""}</li>`;
    files["OEBPS/nav.xhtml"] = xhtml(
      `<nav epub:type="toc"><h1>Contents</h1><ol>${(spec.toc ?? []).map(li).join("")}</ol></nav>` +
        (spec.landmarks
          ? `<nav epub:type="landmarks"><ol>${spec.landmarks.map((l) => `<li><a epub:type="${l.type}" href="${l.href}">${l.type}</a></li>`).join("")}</ol></nav>`
          : ""),
    );
    manifest.push(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  }
  if (spec.ncx) {
    files["OEBPS/toc.ncx"] = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${spec.ncx
      .map((e, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${e.label}</text></navLabel><content src="${e.href}"/></navPoint>`)
      .join("")}</navMap></ncx>`;
    manifest.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  }
  files["OEBPS/content.opf"] = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:test</dc:identifier>
    <dc:title>${spec.title ?? "Test Book"}</dc:title>
    ${spec.author ? `<dc:creator>${spec.author}</dc:creator>` : ""}
    <dc:language>en</dc:language>
  </metadata>
  <manifest>${manifest.join("")}</manifest>
  <spine${spec.ncx ? ' toc="ncx"' : ""}>${spine.join("")}</spine>
  ${spec.guide ? `<guide>${spec.guide.map((g) => `<reference type="${g.type}" href="${g.href}" title="${g.type}"/>`).join("")}</guide>` : ""}
</package>`;
  Object.assign(files, spec.extraFiles ?? {});
  return zip(files, spec.mimetype ?? "application/epub+zip");
}
