import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveBroadcast } from "./broadcast";

describe("serving the broadcast folder", () => {
  let root: string;
  let dir: string;
  const audio = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
  const get = (segments: string[], headers: Record<string, string> = {}, method = "GET") => serveBroadcast(new Request("http://localhost/broadcast/x", { headers, method }), segments, dir);
  const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mr-broadcast-"));
    dir = join(root, "broadcast");
    await mkdir(join(dir, "episodes/dracula-e1"), { recursive: true });
    await writeFile(join(dir, "episodes/dracula-e1/episode.mp3"), audio);
    await writeFile(join(dir, "episodes/dracula-e1/episode.vtt"), "WEBVTT\n");
    await writeFile(join(dir, "stations.json"), '{"stations":[]}');
    await writeFile(join(dir, "notes.txt"), "private");
    await writeFile(join(root, "secret.json"), '{"key":"x"}');
    await symlink(join(root, "secret.json"), join(dir, "leak.json"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves episodes and the station list with their types, and asks clients to revalidate", async () => {
    const r = await get(["episodes", "dracula-e1", "episode.mp3"]);
    expect([r.status, r.headers.get("content-type"), r.headers.get("content-length"), r.headers.get("accept-ranges"), r.headers.get("cache-control")]).toEqual([200, "audio/mpeg", "1000", "bytes", "no-cache"]);
    expect(await bytes(r)).toEqual(audio);
    expect((await get(["episodes", "dracula-e1", "episode.vtt"])).headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    expect(await (await get(["stations.json"])).json()).toEqual({ stations: [] });
    const etag = r.headers.get("etag")!;
    expect((await get(["episodes", "dracula-e1", "episode.mp3"], { "if-none-match": etag })).status).toBe(304);
    const head = await get(["episodes", "dracula-e1", "episode.mp3"], {}, "HEAD");
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, "1000", ""]);
  });

  it("serves byte ranges so the player can seek", async () => {
    const r = await get(["episodes", "dracula-e1", "episode.mp3"], { range: "bytes=100-199" });
    expect([r.status, r.headers.get("content-range"), r.headers.get("content-length")]).toEqual([206, "bytes 100-199/1000", "100"]);
    expect(await bytes(r)).toEqual(audio.slice(100, 200));
    expect(await bytes(await get(["episodes", "dracula-e1", "episode.mp3"], { range: "bytes=990-" }))).toEqual(audio.slice(990));
    expect(await bytes(await get(["episodes", "dracula-e1", "episode.mp3"], { range: "bytes=-5" }))).toEqual(audio.slice(995));
    expect((await get(["episodes", "dracula-e1", "episode.mp3"], { range: "bytes=900-5000" })).headers.get("content-range")).toBe("bytes 900-999/1000");
    for (const bad of ["bytes=1000-", "bytes=5-2", "bytes=-", "items=0-1", "bytes=0-1,5-6"]) {
      const r = await get(["episodes", "dracula-e1", "episode.mp3"], { range: bad });
      expect([bad, r.status, r.headers.get("content-range")]).toEqual([bad, 416, "bytes */1000"]);
    }
  });

  it("serves nothing else: other file types, escapes, links out of the folder, folders and missing files", async () => {
    for (const segments of [["notes.txt"], ["..", "secret.json"], ["episodes", "..", "..", "secret.json"], ["leak.json"], ["episodes", "dracula-e1"], ["missing.mp3"], [], [".hidden.json"], ["a/b.json"]]) {
      expect([segments.join("/"), (await get(segments)).status]).toEqual([segments.join("/"), 404]);
    }
  });

  it("answers 404 when there is no broadcast folder yet", async () => {
    expect((await serveBroadcast(new Request("http://localhost/broadcast/stations.json"), ["stations.json"], join(root, "nowhere"))).status).toBe(404);
  });
});
