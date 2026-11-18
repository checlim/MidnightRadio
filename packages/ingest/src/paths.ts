import { posix } from "node:path";

export interface ResolvedHref {
  /** Archive entry name, e.g. `OEBPS/text/ch01.xhtml`. */
  path: string;
  /** Fragment without `#`, if any. */
  fragment?: string;
}

/**
 * Resolve an href found inside `fromFile` to an archive path. External URLs (`http:`, `data:`,
 * `mailto:` …) and references that escape the archive root return undefined: they are ignored,
 * never fetched.
 */
export function resolveHref(fromFile: string, href: string): ResolvedHref | undefined {
  const raw = href.trim();
  if (raw === "" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith("//")) return undefined;
  const hash = raw.indexOf("#");
  const pathPart = (hash >= 0 ? raw.slice(0, hash) : raw).split("?")[0]!;
  const fragment = hash >= 0 ? safeDecode(raw.slice(hash + 1)) : undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return undefined;
  }
  const base = posix.dirname(fromFile);
  const joined = decoded === "" ? fromFile : posix.normalize(posix.join(base === "." ? "" : base, decoded));
  if (joined.startsWith("../") || joined === ".." || posix.isAbsolute(joined)) return undefined;
  return fragment ? { path: joined, fragment } : { path: joined };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
