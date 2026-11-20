import { open, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * Published episodes and the station list, served from `<DATA_DIR>/broadcast/` at `/broadcast/`.
 * Next serves `public/` only as it was at build time, and episodes are published while the server
 * runs (and seeded onto the data volume), so they need their own route. Public and read-only:
 * only `.mp3`, `.vtt` and `.json` files, plain path segments, nothing outside the folder (links
 * included). Supports one byte range, so the player can seek.
 */

const TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".vtt": "text/vtt; charset=utf-8", ".json": "application/json; charset=utf-8" };
const SEGMENT = /^[\w-][\w.-]{0,99}$/;

const refuse = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

export async function serveBroadcast(request: Request, segments: readonly string[], dir: string): Promise<Response> {
  if (segments.length === 0 || segments.length > 4 || segments.some((s) => !SEGMENT.test(s) || s.includes(".."))) return refuse(404);
  const name = segments[segments.length - 1]!;
  const type = TYPES[name.slice(name.lastIndexOf("."))];
  if (!type) return refuse(404);
  let path: string;
  try {
    const root = await realpath(dir);
    path = await realpath(join(root, ...segments));
    if (!path.startsWith(root + sep)) return refuse(404);
  } catch {
    return refuse(404);
  }
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return refuse(404);
  const size = info.size;
  const etag = `"${size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    etag,
    "last-modified": info.mtime.toUTCString(),
    // Episodes can be re-mixed under the same address after a cast edit, so always revalidate.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = request.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    if (m[1] === "") {
      start = Math.max(0, size - Number(m[2]));
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2]));
    }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = String(end - start + 1);
  if (request.method === "HEAD" || size === 0) return new Response(null, { status, headers });
  // Positioned reads from the start of the range, 64 KB at a time; the file is closed at the end or on cancel.
  const fh = await open(path, "r");
  let position = start;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const left = end + 1 - position;
      if (left <= 0) {
        await fh.close();
        return controller.close();
      }
      const chunk = new Uint8Array(Math.min(64 * 1024, left));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        await fh.close();
        return controller.close();
      }
      position += bytesRead;
      controller.enqueue(chunk.subarray(0, bytesRead));
    },
    async cancel() {
      await fh.close();
    },
  });
  return new Response(body, { status, headers });
}
