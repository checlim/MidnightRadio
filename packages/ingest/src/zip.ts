import type { Readable } from "node:stream";
import yauzl from "yauzl";
import { IngestError } from "./errors.js";
import type { Budget } from "./limits.js";

/** Read-only view of an EPUB's ZIP container. Entries are inflated only on request. */
export interface Archive {
  has(name: string): boolean;
  names(): string[];
  /** Inflate one entry, enforcing size, ratio, total and deadline limits. Undefined if absent. */
  read(name: string): Promise<Buffer | undefined>;
  close(): void;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const unsafe = (why: string) => new IngestError("unsafe_archive", `This EPUB was rejected as unsafe: ${why}.`);

/** Reject names that could escape an extraction directory, even though we never extract to disk. */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return false;
  if (name.includes("\0") || name.includes("\\")) return false;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split("/").some((seg) => seg === ".." || seg === ".");
}

export async function openArchive(bytes: Uint8Array, budget: Budget): Promise<Archive> {
  const { limits } = budget;
  if (bytes.length > limits.maxEpubBytes) {
    const mb = Math.round(limits.maxEpubBytes / (1024 * 1024));
    throw new IngestError("too_large", `This file is larger than the ${mb} MB limit.`);
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new IngestError("not_epub", "This file isn't an EPUB. EPUB files are ZIP archives, and this one isn't.");
  }

  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(buf, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true });
  } catch (err) {
    throw mapZipError(err);
  }

  const entries = new Map<string, yauzl.Entry>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", (err) => reject(mapZipError(err)));
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          budget.checkDeadline();
          if (entries.size >= limits.maxEntries) throw unsafe(`it contains more than ${limits.maxEntries.toLocaleString("en")} files`);
          const name = entry.fileName;
          if (!isSafeEntryName(name)) throw unsafe("it contains a file path that points outside the book");
          if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) throw unsafe("it contains a symbolic link");
          if (entries.has(name)) throw new IngestError("malformed", "This EPUB is damaged: it lists the same file twice.");
          if (!name.endsWith("/")) entries.set(name, entry);
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.readEntry();
    });
  } catch (err) {
    zip.close();
    throw err;
  }

  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    read: async (name) => {
      const entry = entries.get(name);
      if (!entry) return undefined;
      budget.checkDeadline();
      if (entry.isEncrypted()) {
        throw new IngestError("drm", "This EPUB is password-protected or encrypted, so it can't be read.");
      }
      const size = entry.uncompressedSize;
      if (size > limits.maxEntryBytes) throw unsafe("it contains a text file far larger than a book chapter");
      if (size > limits.ratioCheckMinBytes && size / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio) {
        throw unsafe("it contains a file that expands suspiciously (a possible ZIP bomb)");
      }
      budget.chargeInflated(size);
      let stream: Readable;
      try {
        stream = await zip.openReadStreamPromise(entry);
      } catch (err) {
        throw mapZipError(err);
      }
      // validateEntrySizes makes yauzl error if the data inflates beyond the declared size.
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of stream) chunks.push(chunk as Buffer);
      } catch (err) {
        throw mapZipError(err);
      }
      return Buffer.concat(chunks);
    },
    close: () => zip.close(),
  };
}

function mapZipError(err: unknown): IngestError {
  if (err instanceof IngestError) return err;
  const msg = (err as Error)?.message ?? "";
  if (/absolute path|invalid relative path|invalid characters in fileName|backslash/i.test(msg)) {
    return unsafe("it contains a file path that points outside the book");
  }
  if (/too many bytes|too few bytes|size mismatch|exceeded/i.test(msg)) {
    return unsafe("a file's contents don't match its declared size (a possible ZIP bomb)");
  }
  if (/encrypt/i.test(msg)) return new IngestError("drm", "This EPUB is password-protected or encrypted, so it can't be read.");
  return new IngestError("not_epub", "This file isn't a readable EPUB. The ZIP archive inside it is damaged.");
}
