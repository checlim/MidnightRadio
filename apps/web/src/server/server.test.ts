import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUB_VOICE_CATALOGUE, buildCast } from "@midnight-radio/core";
import { saveCast } from "@midnight-radio/db";
import { buildEpub } from "@midnight-radio/ingest/src/test-support/build-epub.js";
import { EPISODE_JOB, JobQueue } from "@midnight-radio/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWebConfig } from "./config";
import { PASSKEY_HEADER, resetGuards, sharedDb } from "./guard";
import { bookRoute, castRoute, generateRoute, uploadRoute } from "./routes";

const FILLER =
  "The night was cold and the road was long. The carriage climbed between dark pines while the wind moved in the branches above. Far below, a river ran black under the moon, and the driver said nothing at all. Every mile the hills grew steeper and the sky grew lower, until the stars were hidden and only the lamps showed the way.";
const epub = async () =>
  new Uint8Array(
    await buildEpub({
      title: "Test Gothic",
      author: "A. Writer",
      docs: [
        { id: "c1", href: "c1.xhtml", body: `<h2>The Door</h2><p>${FILLER}</p><p>\u201cWelcome to my house!\u201d said the Count.</p>` },
        { id: "c2", href: "c2.xhtml", body: `<h2>The Letter</h2><p>${FILLER}</p><p>Mina wrote: \u201cI am waiting.\u201d</p>` },
      ],
      toc: [
        { label: "The Door", href: "c1.xhtml" },
        { label: "The Letter", href: "c2.xhtml" },
      ],
    }),
  );

describe("web configuration", () => {
  it("is off by default and strict about its settings", () => {
    expect(loadWebConfig({}, "/srv/app/apps/web")).toMatchObject({ generationEnabled: false, dataDir: "/data", repoRoot: "/srv/app", bookTtsCharCeiling: 60_000, clientIpHeader: null });
    expect(() => loadWebConfig({ GENERATION_ENABLED: "on" })).toThrow('GENERATION_ENABLED must be "true" or "false"');
    expect(() => loadWebConfig({ CLIENT_IP_HEADER: "X-Forwarded-For" })).toThrow(/not x-forwarded-for/);
    expect(loadWebConfig({ CLIENT_IP_HEADER: "Fly-Client-IP" }).clientIpHeader).toBe("fly-client-ip");
  });
});

describe("generation routes", () => {
  let dir: string;
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = (path: string, body: BodyInit | null, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { method: "POST", body, headers, duplex: "half" } as RequestInit);
  const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers });
  const upload = async (headers: Record<string, string> = {}) => uploadRoute(post("/api/books", await epub(), { "x-file-name": "test-gothic.epub", ...headers }));
  const ID = "bk-0123456789abcdef";
  const all = async (headers: Record<string, string> = {}) => [
    await upload(headers),
    await bookRoute(get(`/api/books/${ID}`, headers), ctx(ID)),
    await generateRoute(post(`/api/books/${ID}/generate`, JSON.stringify({ chapters: [1], charBudget: 1000 }), headers), ctx(ID)),
    await castRoute(post(`/api/books/${ID}/cast`, JSON.stringify({ changes: [{ name: "x", voiceId: "y" }] }), headers), ctx(ID)),
  ];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-web-"));
    vi.stubEnv("DATA_DIR", dir);
    vi.stubEnv("MIDNIGHT_STUB_PROVIDERS", "true");
    vi.stubEnv("GENERATION_ENABLED", "");
    vi.stubEnv("UPLOAD_PASSKEY", "");
    vi.stubEnv("BOOK_TTS_CHAR_LIMIT", "50000");
    resetGuards();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("with generation disabled, every route answers 404 and touches nothing", async () => {
    for (const r of await all()) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "Generation is not available on this site." });
    }
    expect(readdirSync(dir)).toEqual([]); // no database, no uploads
  });

  it("with a passkey set, every route needs it, and repeated wrong guesses lock the client out", async () => {
    vi.stubEnv("GENERATION_ENABLED", "true");
    vi.stubEnv("UPLOAD_PASSKEY", "judge-passkey-0123456789");
    resetGuards();
    for (const r of await all()) expect([r.status, (await r.json()).error]).toEqual([401, "A valid judge passkey is required to generate new episodes."]);
    const ok = await upload({ [PASSKEY_HEADER]: "judge-passkey-0123456789" });
    expect(ok.status).toBe(201);
    expect(JSON.stringify(await ok.json())).not.toContain("judge-passkey");
    // Three wrong write attempts so far; the fourth and fifth are refused, then the client is locked out.
    expect((await upload({ [PASSKEY_HEADER]: "guess-one" })).status).toBe(401);
    expect((await upload({ [PASSKEY_HEADER]: "guess-two" })).status).toBe(401);
    const locked = await upload({ [PASSKEY_HEADER]: "judge-passkey-0123456789" });
    expect([locked.status, (await locked.json()).error, locked.headers.get("retry-after")]).toEqual([429, "Too many incorrect passkey attempts. Try again later.", expect.stringMatching(/^\d+$/)]);
  });

  describe("with generation enabled", () => {
    beforeEach(() => vi.stubEnv("GENERATION_ENABLED", "true"));

    it("uploads an EPUB: lists its chapters, keeps the file, and returns the same Book on a second upload", async () => {
      const r = await upload();
      expect(r.status).toBe(201);
      const book = await r.json();
      expect(book).toMatchObject({ title: "Test Gothic", author: "A. Writer", charBudget: 50_000, charCeiling: 50_000, charsSpent: 0, cast: null });
      expect(book.chapters.map((c: { number: number; title: string; episodes: { state: string; episodeNumber: number }[] }) => [c.number, c.title, c.episodes.map((e) => [e.episodeNumber, e.state])])).toEqual([
        [1, "The Door", [[1, "not_started"]]],
        [2, "The Letter", [[2, "not_started"]]],
      ]);
      expect(existsSync(join(dir, "uploads", `${book.id}.epub`))).toBe(true);
      const again = await (await upload()).json();
      expect(again.id).toBe(book.id);
      const view = await bookRoute(get(`/api/books/${book.id}`), ctx(book.id));
      expect(view.status).toBe(200);
      expect((await view.json()).voices).toEqual(expect.arrayContaining([expect.objectContaining({ id: "stub-m1" })]));
    });

    it("refuses what is not a usable EPUB, with the reason, and creates no Book", async () => {
      const refusals = [
        [await uploadRoute(post("/api/books", await epub(), { "x-file-name": "book.pdf" })), 415, "Only .epub files can be uploaded."],
        [await uploadRoute(post("/api/books", new Uint8Array(10), { "x-file-name": "bad.epub" })), 422, /^This EPUB cannot be used: /],
        [await uploadRoute(post("/api/books", new Uint8Array(0), { "x-file-name": "empty.epub" })), 400, "No file was sent."],
        [await uploadRoute(post("/api/books", "x", { "x-file-name": "big.epub", "content-length": String(21 * 1024 * 1024) })), 413, "The file is larger than 20 MB."],
      ] as const;
      for (const [r, status, message] of refusals) {
        expect(r.status).toBe(status);
        expect((await r.json()).error).toEqual(typeof message === "string" ? message : expect.stringMatching(message));
      }
      let pulled = 0;
      const big = new ReadableStream<Uint8Array>({
        pull(c) {
          if (++pulled > 200) return c.close();
          c.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      expect((await uploadRoute(post("/api/books", big, { "x-file-name": "streamed.epub" }))).status).toBe(413); // no Content-Length
      expect(pulled).toBeLessThan(30); // reading stopped just past 20 MB instead of taking all 200 MB
      expect(sharedDb(loadWebConfig()).prepare("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 0 });
      expect(existsSync(join(dir, "uploads"))).toBe(false);
    });

    it("queues the chosen chapters within the operator's budget ceiling, and resumes a job parked over budget", async () => {
      const book = await (await upload()).json();
      const gen = (body: unknown) => generateRoute(post(`/api/books/${book.id}/generate`, JSON.stringify(body)), ctx(book.id));
      expect((await gen({ chapters: [1], charBudget: 50_001 })).status).toBe(422);
      expect((await gen({ chapters: [3], charBudget: 1000 })).status).toBe(422);
      expect((await gen({ chapters: [], charBudget: 1000 })).status).toBe(400);
      const db = sharedDb(loadWebConfig());
      const queue = new JobQueue(db);
      const ch2 = book.chapters[1].episodes[0].chapterId;
      const parked = queue.enqueue(EPISODE_JOB, ch2);
      db.prepare("UPDATE jobs SET state = 'over_budget' WHERE id = ?").run(parked.id);
      const r = await gen({ chapters: [2, 1, 1], charBudget: 20_000 });
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ queued: [book.chapters[0].episodes[0].chapterId, ch2] });
      expect(queue.get(parked.id)!.state).toBe("queued");
      const view = await (await bookRoute(get(`/api/books/${book.id}`), ctx(book.id))).json();
      expect(view.charBudget).toBe(20_000);
      expect(view.chapters.map((c: { episodes: { state: string }[] }) => c.episodes[0]!.state)).toEqual(["queued", "queued"]);
      expect((await bookRoute(get("/api/books/../../etc"), ctx("../../etc"))).status).toBe(404);
    });

    it("changes a voice, refuses a reserved one, and queues only the episodes that use the character", async () => {
      const book = await (await upload()).json();
      const db = sharedDb(loadWebConfig());
      const { pin, members } = buildCast(
        [{ id: "c1", name: "Count Dracula", aliases: [], genderPresentation: "masculine", ageBand: "older", description: "A host.", speaks: true, mentionCount: 3, firstChapterIdx: 0 }],
        STUB_VOICE_CATALOGUE,
      );
      const cast = (body: unknown) => castRoute(post(`/api/books/${book.id}/cast`, JSON.stringify(body)), ctx(book.id));
      expect((await cast({ changes: [{ name: "Count Dracula", voiceId: "stub-m1" }] })).status).toBe(404); // no Cast yet
      saveCast(db, book.id, pin, members);
      const ch1 = book.chapters[0].episodes[0].chapterId;
      // Chapter 1 has an episode with one of the Count's lines; chapter 2 has none.
      const script = db.prepare("INSERT INTO scripts (id, chapter_id, version, json, status) VALUES ('s1', ?, 1, '{}', 'valid') RETURNING id").get(ch1) as { id: string };
      db.prepare("INSERT INTO segments (id, script_id, section, scene_idx, idx, kind, speaker, text, status) VALUES ('g1', ?, 'scenes', 0, 0, 'dialogue', 'Count Dracula', 'Welcome!', 'rendered')").run(script.id);
      db.prepare("INSERT INTO episodes (id, chapter_id, mp3_path, clean_mp3_path, vtt_path, duration_ms) VALUES ('e1', ?, 'a', 'b', 'c', 1000)").run(ch1);

      const reserved = await cast({ changes: [{ name: "Count Dracula", voiceId: STUB_VOICE_CATALOGUE.reserved.narrator }] });
      expect([reserved.status, (await reserved.json()).error]).toEqual([422, expect.stringMatching(/belongs to the Announcer or Narrator/)]);
      const free = STUB_VOICE_CATALOGUE.voices.find((v) => v.id !== members[2]!.voiceId && v.id !== members[0]!.voiceId && v.id !== members[1]!.voiceId)!;
      const r = await cast({ changes: [{ name: "count dracula", voiceId: free.id }] });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ changed: ["Count Dracula"], requeued: [ch1] });
      const view = await (await bookRoute(get(`/api/books/${book.id}`), ctx(book.id))).json();
      expect(view.cast.characters).toEqual([expect.objectContaining({ name: "Count Dracula", voiceId: free.id })]);
      expect(view.chapters[0].episodes[0].state).toBe("queued");
      expect(view.chapters[1].episodes[0].state).toBe("not_started");
    });
  });
});
