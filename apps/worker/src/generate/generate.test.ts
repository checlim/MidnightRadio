import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { STUB_VOICE_CATALOGUE, StationListSchema, designedVoiceId, type AdaptedScript, type SfxCatalogue, type Station } from "@midnight-radio/core";
import { BudgetLedger, loadCast, openDb, type BudgetConfig, type StoredCast } from "@midnight-radio/db";
import { ingestEpub } from "@midnight-radio/ingest";
import { buildEpub } from "@midnight-radio/ingest/src/test-support/build-epub.js";
import { StubLlmProvider, type LlmRequest } from "@midnight-radio/llm";
import { StubProvider, StubVoiceDesigner, TtsError, encodeWav, type QwenTtsOptions, type SynthesisRequest } from "@midnight-radio/tts";
import { speechSpy, voiceDeps } from "./test-support.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptCast, speechLines, validationCast } from "./cast-lines.js";
import { BudgetStopError, GenerateError, generateBook, needsLlm, type GenerateDeps } from "./pipeline.js";
import { planBook, selectChapters, slug } from "./plan.js";
import { preflight } from "./preflight.js";
import { mergeStations, readStations, writeStations } from "./stations.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
if (process.env.REQUIRE_FFMPEG === "1" && !hasFfmpeg) throw new Error("REQUIRE_FFMPEG=1 but ffmpeg is not on the PATH");

const FILLER =
  "The night was cold and the road was long. The carriage climbed between dark pines while the wind moved in the branches above. Far below, a river ran black under the moon, and the driver said nothing at all. Every mile the hills grew steeper and the sky grew lower, until the stars were hidden and only the lamps showed the way. At last the walls of an old castle rose out of the dark, with no light in any window and no sound from any door.";
const CH1 = `<h2>The Door</h2><p>${FILLER}</p><p>\u201cWelcome to my house!\u201d said the Count.</p><p>\u201cCount Dracula?\u201d Jonathan asked.</p>`;
const CH2 = `<h2>The Letter</h2><p>${FILLER}</p><p>Mina wrote: \u201cI am waiting for you.\u201d</p>`;
const epub = () =>
  buildEpub({
    title: "Test Gothic",
    author: "A. Writer",
    docs: [
      { id: "c1", href: "c1.xhtml", body: CH1 },
      { id: "c2", href: "c2.xhtml", body: CH2 },
    ],
    toc: [
      { label: "The Door", href: "c1.xhtml" },
      { label: "The Letter", href: "c2.xhtml" },
    ],
  });

const character = (name: string, gender: "masculine" | "feminine", age: "older" | "young-adult") => ({ name, aliases: [], genderPresentation: gender, ageBand: age, description: `${name} appears.`, speaks: true });
const script = (n: number, dialogue: { speaker: string; text: string }[]): AdaptedScript => ({
  coldOpen: [
    { kind: "announcer", text: `Good evening. This is Midnight Radio. Episode ${n}.` },
    { kind: "music", cue: "theme" },
  ],
  scenes: [{ id: "s1", segments: [{ kind: "narration", text: "A cold night on a mountain road." }, ...dialogue.map((d) => ({ kind: "dialogue" as const, ...d }))] }],
  close: [
    { kind: "announcer", text: "Tune in next time to Midnight Radio." },
    { kind: "music", cue: "theme" },
  ],
});
/** A model that casts the book and adapts each chapter correctly. `bad` makes every adaptation reply invent a line. */
const model = (opts: { bad?: boolean } = {}) =>
  new StubLlmProvider((req: LlmRequest) => {
    if (req.jsonSchema.name === "voice_briefs") {
      const names = [...req.user.matchAll(/^- (.+?)(?: \(also: .*?\))?(?:;.*)?$/gm)].map((m) => m[1]!);
      return JSON.stringify({ voices: names.map((name) => ({ name, brief: `A distinct, clear voice for ${name}, at an even pace.` })) });
    }
    if (req.jsonSchema.name === "chunk_characters") {
      // Like a real model, it names only the characters in the excerpt it was given.
      const all = [character("Count Dracula", "masculine", "older"), character("Jonathan Harker", "masculine", "young-adult"), character("Mina Harker", "feminine", "young-adult")];
      return JSON.stringify({ characters: all.filter((c) => req.user.includes(c.name.split(" ")[0]!)) });
    }
    if (opts.bad) return JSON.stringify(script(1, [{ speaker: "Count Dracula", text: "Something I never said." }]));
    if (req.user.includes("Welcome to my house")) {
      return JSON.stringify(script(1, [{ speaker: "Count Dracula", text: "Welcome to my house!" }, { speaker: "Jonathan Harker", text: "Count Dracula?" }]));
    }
    return JSON.stringify(script(2, [{ speaker: "Mina Harker", text: "I am waiting for you." }]));
  });

const RATE = 24_000;
const BUDGET: BudgetConfig = { dailyTtsChars: 1_000_000, dailyLlmTokens: 10_000_000, bookTtsCharCeiling: 100_000 };

describe("planning", () => {
  it("numbers episodes over the whole book, with ids that depend only on the EPUB", async () => {
    const bytes = new Uint8Array(await epub());
    const plan = planBook(await ingestEpub(bytes), bytes);
    expect(plan.episodes.map((e) => [e.chapterNumber, e.episodeNumber, e.title])).toEqual([
      [1, 1, "The Door"],
      [2, 2, "The Letter"],
    ]);
    expect(plan.bookId).toMatch(/^bk-[0-9a-f]{16}$/);
    expect(plan.episodes[0]!.stationId).toMatch(/^test-gothic-[0-9a-f]{6}-e1$/);
    expect(plan.episodes[0]!.quotes.map((q) => q.text)).toEqual(["Welcome to my house!", "Count Dracula?"]);
    expect(planBook(await ingestEpub(bytes), bytes)).toEqual(plan);
  });

  it("reads --chapters", () => {
    expect([...selectChapters("all", 3)]).toEqual([1, 2, 3]);
    expect([...selectChapters("1, 3-4", 5)]).toEqual([1, 3, 4]);
    expect(() => selectChapters("0", 3)).toThrow("--chapters: 0 is outside 1–3");
    expect(() => selectChapters("2-9", 3)).toThrow(/outside/);
    expect(() => selectChapters("two", 3)).toThrow(/not a chapter number/);
  });

  it("makes safe slugs", () => {
    expect(slug("The Fall of the House of Usher")).toBe("the-fall-of-the-house-of-usher");
    expect(slug("Ça ira! ***")).toBe("ca-ira");
    expect(slug("***")).toBe("book");
  });
});

describe("cast and lines", () => {
  const cast: StoredCast = {
    pin: { catalogueId: "c", catalogueHash: "h" },
    announcer: { name: "Announcer", role: "announcer", aliases: [], genderPresentation: null, ageBand: null, description: null, voiceId: "v-a", voiceFit: null, mentionCount: 0, speaks: true },
    narrator: { name: "Narrator", role: "narrator", aliases: [], genderPresentation: null, ageBand: null, description: null, voiceId: "v-n", voiceFit: null, mentionCount: 0, speaks: true },
    characters: [
      { name: "Count Dracula", role: "character", aliases: ["the Count"], genderPresentation: "masculine", ageBand: "older", description: "A nobleman.", voiceId: "v-d", voiceFit: "good", mentionCount: 9, speaks: true, firstChapterIdx: 1 },
      { name: "The landlady", role: "character", aliases: [], genderPresentation: "feminine", ageBand: null, description: "Warns him.", voiceId: null, voiceFit: null, mentionCount: 1, speaks: false },
    ],
  };

  it("gives each spoken segment its Cast voice, matching speakers as the gate does", () => {
    const s = script(1, [{ speaker: "count dracula", text: "Welcome!" }]);
    s.scenes[0]!.segments.push({ kind: "dialogue", speaker: "Count Dracula", text: "Enter.", delivery: "sinister" }, { kind: "pause", ms: 500 });
    expect(speechLines(s, cast)).toEqual([
      { id: "coldOpen[0]", voiceId: "v-a", text: "Good evening. This is Midnight Radio. Episode 1." },
      { id: "scenes[0].segments[0]", voiceId: "v-n", text: "A cold night on a mountain road." },
      { id: "scenes[0].segments[1]", voiceId: "v-d", text: "Welcome!" },
      { id: "scenes[0].segments[2]", voiceId: "v-d", text: "Enter.", delivery: "sinister" },
      { id: "close[0]", voiceId: "v-a", text: "Tune in next time to Midnight Radio." },
    ]);
    expect(() => speechLines(script(1, [{ speaker: "The landlady", text: "Go back!" }]), cast)).toThrow('"The landlady" has no voice');
    expect(() => speechLines(script(1, [{ speaker: "Renfield", text: "Master!" }]), cast)).toThrow(/"Renfield" has no voice/);
  });

  it("shows the prompt each character's first chapter, and the gate the whole Cast", () => {
    expect(promptCast(cast)).toEqual([
      { name: "Count Dracula", aliases: ["the Count"], genderPresentation: "masculine", description: "A nobleman.", speaks: true, firstChapterIdx: 1 },
      { name: "The landlady", aliases: [], genderPresentation: "feminine", description: "Warns him.", speaks: false },
    ]);
    expect(validationCast(cast).map((m) => [m.name, m.role, m.speaks])).toEqual([
      ["Announcer", "announcer", true],
      ["Narrator", "narrator", true],
      ["Count Dracula", "character", true],
      ["The landlady", "character", false],
    ]);
  });
});

describe("stations", () => {
  const st = (id: string, title = id): Station => ({ status: "ready", id, book: "B", author: "A", episodeNumber: 1, title, durationMs: 1000, cleanUrl: `/broadcast/episodes/${id}/episode.mp3`, amUrl: `/episodes/${id}/episode-am.mp3`, vttUrl: `/episodes/${id}/episode.vtt` });

  it("replaces by id in place, keeps others, appends new ones", () => {
    expect(mergeStations([st("a"), st("b")], [st("b", "new"), st("c")]).map((s) => [s.id, s.title])).toEqual([
      ["a", "a"],
      ["b", "new"],
      ["c", "c"],
    ]);
    expect(() => mergeStations([], [{ ...st("x"), cleanUrl: "//evil.example/x.mp3" } as Station])).toThrow();
  });

  it("writes atomically and refuses to overwrite a malformed list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mr-stations-"));
    try {
      const path = join(dir, "stations.json");
      expect(await readStations(path)).toEqual([]);
      await writeStations(path, [st("a")]);
      expect(await readStations(path)).toEqual([st("a")]);
      await writeFile(path, "{ nope");
      await expect(readStations(path)).rejects.toThrow();
      await writeFile(path, JSON.stringify({ stations: [{ id: "x" }] }));
      await expect(readStations(path)).rejects.toThrow(/not a valid station list/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("preflight", () => {
  let dir: string;
  let paths: { voiceCatalogue: string; voiceClips: string; voiceDesignPin: string; sfxIndex: string; styleGuide: string };
  const sfx: SfxCatalogue = { version: 1, id: "lib", entries: [{ id: "theme_x", kind: "music", title: "Theme", path: "music/t.wav", sha256: "a".repeat(64), durationMs: 3000, loopable: false, peakDb: -1, tags: [], source: { type: "project", author: "x", licence: "CC0-1.0" } }], musicCues: { theme: "theme_x" } };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-preflight-"));
    paths = { voiceCatalogue: join(dir, "voices.json"), voiceClips: dir, voiceDesignPin: join(dir, "voice-design.json"), sfxIndex: join(dir, "index.json"), styleGuide: join(dir, "style.md") };
    await writeFile(paths.voiceDesignPin, JSON.stringify({ name: "design (float32)", revision: "d1" }));
    const clip = { file: "clips/a.wav", sha256: "b".repeat(64), transcript: "Good evening." };
    await writeFile(paths.voiceCatalogue, JSON.stringify({ ...STUB_VOICE_CATALOGUE, voices: STUB_VOICE_CATALOGUE.voices.map((v) => ({ ...v, description: v.description ?? "A voice.", clip })) }));
    await writeFile(paths.sfxIndex, JSON.stringify(sfx));
    await writeFile(paths.styleGuide, "# Style");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const GOOD_ENV = { LLM_API_KEY: "sk-test-key-0123456789", LLM_MODEL: "gpt-x", GLOBAL_DAILY_LLM_TOKEN_LIMIT: "1000000", GLOBAL_DAILY_TTS_CHAR_LIMIT: "1000000" };
  const okFetch = (async () => new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), { status: 200 })) as unknown as typeof fetch;
  const connectOk = async (o: QwenTtsOptions) => new StubProvider(o.catalogue.voices);
  const designers: unknown[] = [];
  const connectDesignerOk = async (o: unknown) => (designers.push(o), new StubVoiceDesigner());
  const hooks = { fetch: okFetch, connectTts: connectOk, connectDesigner: connectDesignerOk, hasProgram: () => true };
  const ALL = { llm: true, design: true };

  it("passes when everything is in place, and notes a library without sound effects", async () => {
    const r = await preflight(GOOD_ENV, paths, ALL, hooks);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready.llm?.id).toBe("openai-compatible:gpt-x");
      expect(r.ready.notes).toEqual([expect.stringMatching(/no sound effects yet/)]);
    }
  });

  it("lists every problem at once, before any paid call", async () => {
    let fetched = 0;
    await rm(paths.sfxIndex);
    const r = await preflight({}, paths, ALL, {
      fetch: (async () => {
        fetched++;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      connectTts: async () => {
        throw new Error("the local audio service is not running");
      },
      hasProgram: (p) => p !== "ffprobe",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems).toEqual([
        expect.stringMatching(/^LLM calls are switched off: set GLOBAL_DAILY_LLM_TOKEN_LIMIT/),
        expect.stringMatching(/^speech rendering is switched off: set GLOBAL_DAILY_TTS_CHAR_LIMIT/),
        expect.stringMatching(/^no LLM configured: set LLM_API_KEY and LLM_MODEL/),
        expect.stringMatching(/^no sound library at .*: run pnpm sfx:build/),
        "ffprobe is not on the PATH (macOS: brew install ffmpeg)",
        expect.stringMatching(/^Qwen3-TTS is not ready: the local audio service is not running\. Start the speech server/),
        expect.stringMatching(/^voice design is not ready: /), // no designer hook: nothing is listening
      ]);
    }
    expect(fetched).toBe(0);
  });

  it("reports a refused key, a missing theme and an unusable voice catalogue", async () => {
    await writeFile(paths.sfxIndex, JSON.stringify({ ...sfx, musicCues: {} }));
    await writeFile(paths.voiceCatalogue, JSON.stringify(STUB_VOICE_CATALOGUE)); // no clips: cannot clone
    const r = await preflight(GOOD_ENV, paths, ALL, { ...hooks, fetch: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems).toEqual([
        "the LLM endpoint refused LLM_API_KEY (HTTP 401)",
        expect.stringMatching(/^the voice catalogue .* cannot be used/),
        "the sound library has no theme music pinned: run pnpm --filter @midnight-radio/mix sfx:music",
      ]);
      expect(r.problems.join(" ")).not.toContain("sk-test");
    }
  });

  it("does not ask for an LLM when nothing is left to cast or adapt", async () => {
    designers.length = 0;
    const r = await preflight({ GLOBAL_DAILY_TTS_CHAR_LIMIT: "1000" }, paths, { llm: false, design: false }, hooks);
    expect(r.ok && r.ready.llm).toBe(null);
    expect(designers).toEqual([]); // voice design is checked only while a book still needs its voices
  });

  it("checks voice design against the pinned build while a book still needs its voices", async () => {
    const r = await preflight(GOOD_ENV, paths, ALL, {
      ...hooks,
      connectDesigner: async () => {
        throw new Error("the speech service has no voice-design model (start it with voice design enabled)");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual([expect.stringMatching(/^voice design is not ready: the speech service has no voice-design model .*start the speech server with its VoiceDesign model/)]);
    await writeFile(paths.voiceDesignPin, "{ nope");
    const broken = await preflight(GOOD_ENV, paths, { llm: true, design: false }, hooks);
    expect(!broken.ok && broken.problems).toEqual([expect.stringMatching(/^the voice-design pin .* cannot be used/)]);
  });
});

describe.skipIf(!hasFfmpeg)("generateBook end to end (stub model, stub voices, real ffmpeg)", () => {
  let dir: string;
  let db: DatabaseSync;
  let bytes: Uint8Array;
  let deps: GenerateDeps;
  let tts: { requests: SynthesisRequest[] };
  let designer: StubVoiceDesigner;
  let v: Awaited<ReturnType<typeof voiceDeps>>;
  const logs: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-generate-"));
    db = openDb(join(dir, "mr.db"));
    bytes = new Uint8Array(await epub());
    const sfxDir = join(dir, "sfx");
    await mkdir(join(sfxDir, "music"), { recursive: true });
    await writeFile(join(sfxDir, "music/theme.wav"), encodeWav(Int16Array.from({ length: 2 * RATE }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 196 * i) / RATE) * Math.min(1, i / 2400, (2 * RATE - i) / 2400)))));
    const sfx: SfxCatalogue = { version: 1, id: "lib", entries: [{ id: "theme_x", kind: "music", title: "Theme", path: "music/theme.wav", sha256: "a".repeat(64), durationMs: 2000, loopable: false, peakDb: -1, tags: [], source: { type: "project", author: "x", licence: "CC0-1.0" } }], musicCues: { theme: "theme_x" } };
    const speech = speechSpy();
    tts = speech;
    v = await voiceDeps(dir);
    designer = v.designer;
    logs.length = 0;
    deps = { db, ledger: new BudgetLedger(db, BUDGET), llm: model(), ttsFor: speech.ttsFor, designer: v.designerFn, series: v.series, seriesDir: v.seriesDir, designPin: v.designPin, voicesRoot: v.voicesRoot, sfx, sfxDir, styleGuide: "# Style", cacheDir: join(dir, "cache"), broadcastDir: join(dir, "public"), log: (m) => logs.push(m), ff: { log: () => {} }, delay: async () => undefined };
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const plan = async () => planBook(await ingestEpub(bytes), bytes);
  const stations = async () => StationListSchema.parse(JSON.parse(await readFile(join(dir, "public/stations.json"), "utf8"))).stations;

  it("casts once, adapts, renders, mixes and publishes; a rerun reuses everything", async () => {
    const p = await plan();
    const llm = deps.llm as StubLlmProvider;
    expect(needsLlm(db, p, { chapters: new Set([1]), charBudget: 0 })).toBe(true);
    const first = await generateBook(p, { chapters: new Set([1]), charBudget: 50_000 }, deps);
    expect(first).toEqual([{ stationId: p.episodes[0]!.stationId, episodeNumber: 1, title: "The Door", status: "ready", durationMs: expect.any(Number), reused: false }]);
    const id = p.episodes[0]!.stationId;
    for (const f of ["episode.mp3", "episode-am.mp3", "episode.vtt"]) expect(existsSync(join(dir, "public/episodes", id, f))).toBe(true);
    expect(await stations()).toEqual([expect.objectContaining({ status: "ready", id, book: "Test Gothic", author: "A. Writer", episodeNumber: 1, title: "The Door", cleanUrl: `/broadcast/episodes/${id}/episode.mp3` })]);
    expect(await readFile(join(dir, "public/episodes", id, "episode.vtt"), "utf8")).toContain("Welcome to my house!");
    const cast = loadCast(db, p.bookId)!;
    expect(cast.characters.map((c) => [c.name, c.firstChapterIdx])).toEqual(expect.arrayContaining([["Count Dracula", 0], ["Mina Harker", 1]]));
    expect(db.prepare("SELECT status, quote_parse_status AS q FROM chapters WHERE id = ?").get(p.episodes[0]!.chapterId)).toEqual({ status: "adapted", q: "ok" });
    const calls = llm.requests.length;
    const renders = tts.requests.length;
    expect(deps.ledger.bookSpend(p.bookId).ttsChars).toBe(tts.requests.reduce((n, r) => n + r.text.length, 0)); // speech is metered

    expect(needsLlm(db, p, { chapters: new Set([1]), charBudget: 0 })).toBe(false);
    const again = await generateBook(p, { chapters: new Set([1]), charBudget: 50_000 }, { ...deps, llm: null });
    expect(again[0]).toMatchObject({ status: "ready", reused: true });
    expect([llm.requests.length, tts.requests.length]).toEqual([calls, renders]);

    // The next chapter: no second casting pass, one adaptation, the station list grows.
    const second = await generateBook(p, { chapters: new Set([2]), charBudget: 50_000 }, deps);
    expect(second[0]).toMatchObject({ episodeNumber: 2, status: "ready", reused: false });
    expect(llm.requests.slice(calls).map((r) => r.jsonSchema.name)).toEqual(["radio_script"]);
    expect((await stations()).map((s) => s.episodeNumber)).toEqual([1, 2]);
  }, 120_000);

  it("designs a voice for every speaking character from their brief, casts each on their own, and renders with them", async () => {
    const p = await plan();
    await generateBook(p, { chapters: new Set([1]), charBudget: 50_000 }, deps);
    const cast = loadCast(db, p.bookId)!;
    expect(cast.pin.catalogueId).toBe(`book-${p.bookId}`);
    expect(cast.characters.map((c) => [c.name, c.voiceId])).toEqual(expect.arrayContaining([["Count Dracula", designedVoiceId("Count Dracula")], ["Jonathan Harker", designedVoiceId("Jonathan Harker")], ["Mina Harker", designedVoiceId("Mina Harker")]]));
    expect(designer.requests.map((r) => r.instruct).sort()).toEqual(["Count Dracula", "Jonathan Harker", "Mina Harker"].map((n) => `A distinct, clear voice for ${n}, at an even pace.`));
    expect(tts.requests.filter((r) => r.voiceId === designedVoiceId("Count Dracula")).map((r) => r.text)).toEqual(["Welcome to my house!"]);
    expect(tts.requests.some((r) => r.voiceId === v.series.reserved.narrator)).toBe(true); // the series Narrator
    expect(existsSync(join(dir, "voices", p.bookId, "catalogue.json"))).toBe(true);
    const llm = deps.llm as StubLlmProvider;
    expect(llm.requests.filter((r) => r.jsonSchema.name === "voice_briefs")).toHaveLength(1);
    const designs = designer.requests.length;
    await generateBook(p, { chapters: new Set([2]), charBudget: 50_000 }, deps);
    expect(designer.requests.length).toBe(designs); // voices are designed once per book
  }, 120_000);

  it("after a crash before the voices were designed, resumes without casting or writing briefs again", async () => {
    const p = await plan();
    const failing = { ...deps, designer: async () => Promise.reject(new TtsError("unavailable", "the speech service has no voice-design model", false, false)) };
    await expect(generateBook(p, { chapters: new Set([1]), charBudget: 50_000 }, failing)).rejects.toThrow(/voice design is not available/);
    const llm = deps.llm as StubLlmProvider;
    const calls = llm.requests.map((r) => r.jsonSchema.name);
    expect(calls).toContain("voice_briefs");
    await generateBook(p, { chapters: new Set([1]), charBudget: 50_000 }, deps);
    expect(llm.requests.slice(calls.length).map((r) => r.jsonSchema.name)).toEqual(["radio_script"]);
  }, 120_000);

  it("re-renders and re-mixes an episode whose files are gone, from the stored Script and cached lines", async () => {
    const p = await plan();
    await generateBook(p, { chapters: new Set([1]), charBudget: 50_000 }, deps);
    const llmCalls = (deps.llm as StubLlmProvider).requests.length;
    const renders = tts.requests.length;
    expect(deps.ledger.bookSpend(p.bookId).ttsChars).toBe(tts.requests.reduce((n, r) => n + r.text.length, 0)); // speech is metered
    await rm(join(dir, "public/episodes", p.episodes[0]!.stationId, "episode.mp3"));
    const r = await generateBook(p, { chapters: new Set([1]), charBudget: 50_000 }, deps);
    expect(r[0]).toMatchObject({ status: "ready", reused: false });
    expect([(deps.llm as StubLlmProvider).requests.length, tts.requests.length]).toEqual([llmCalls, renders]);
  }, 120_000);

  it("reports an episode whose adaptation keeps failing and goes on, publishing nothing for it", async () => {
    const p = await plan();
    const r = await generateBook(p, { chapters: new Set([1, 2]), charBudget: 50_000 }, { ...deps, llm: model({ bad: true }) });
    expect(r.map((e) => [e.episodeNumber, e.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
    ]);
    expect(r[0]!.status === "failed" && r[0]!.reason).toMatch(/^adaptation failed \(attempts_exhausted\)/);
    expect(existsSync(join(dir, "public/stations.json"))).toBe(false);
    expect(db.prepare("SELECT status FROM chapters WHERE id = ?").get(p.episodes[0]!.chapterId)).toEqual({ status: "failed" });
  }, 120_000);

  it("stops with what to change when a daily cap is reached", async () => {
    const p = await plan();
    const tight = new BudgetLedger(db, { ...BUDGET, dailyLlmTokens: 10 });
    const err = await generateBook(p, { chapters: new Set([1]), charBudget: 50_000 }, { ...deps, ledger: tight }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetStopError);
    expect((err as Error).message).toMatch(/GLOBAL_DAILY_LLM_TOKEN_LIMIT.*run again; finished work is kept/);
  });

  it("needs an LLM only while something is left to cast or adapt", async () => {
    const p = await plan();
    await expect(generateBook(p, { chapters: new Set([1]), charBudget: 50_000 }, { ...deps, llm: null })).rejects.toThrow(new GenerateError("the book has no Cast yet and no LLM is configured"));
  });
});
