import type { DatabaseSync } from "node:sqlite";
import type { AdaptedScript } from "@midnight-radio/core";
import { BudgetExceededError, BudgetLedger, openDb, type BudgetConfig } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adaptChapter, adaptationOutputTokens, feedbackText } from "./adapt.js";
import type { AdaptationInput } from "./adapt-prompt.js";
import { LlmError } from "./provider.js";
import { StubLlmProvider } from "./stub.js";

const CFG: BudgetConfig = { dailyTtsChars: 0, dailyLlmTokens: 1_000_000, bookTtsCharCeiling: 60_000 };
const TEXT = 'Jonathan Harker reached the castle. "Welcome to my house!" said the Count.';
const INPUT: AdaptationInput = {
  book: { title: "Dracula", author: "Bram Stoker" },
  chapter: { idx: 1, title: "Jonathan Harker's Journal (continued)", part: 1, partCount: 1, canonicalText: TEXT },
  episodeNumber: 2,
  cast: [{ name: "Count Dracula", aliases: ["the Count"], genderPresentation: "masculine", description: null, speaks: true }],
  sfx: { version: 1, id: "empty", entries: [], musicCues: {} },
  styleGuide: "# Style\nBe spooky.",
};
const GOOD: AdaptedScript = {
  coldOpen: [{ kind: "announcer", text: "Good evening. Midnight Radio presents Episode 2: Jonathan Harker's Journal, continued." }],
  scenes: [{ id: "castle", segments: [{ kind: "narration", text: "Harker reaches the castle at last." }, { kind: "dialogue", speaker: "Count Dracula", text: "Welcome to my house!", delivery: "sinister" }] }],
  close: [{ kind: "announcer", text: "What does the Count want? Tune in next time to Midnight Radio." }, { kind: "music", cue: "theme" }],
};
const noDelay = async () => undefined;

let db: DatabaseSync;
let ledger: BudgetLedger;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'Dracula', 'h', 'ready', 0)").run();
  db.prepare("INSERT INTO chapters (id, book_id, idx, title, source_text, canonical_text, word_count, status) VALUES ('c2', 'b1', 1, 't', 's', 's', 1, 'ready')").run();
  ledger = new BudgetLedger(db, CFG);
});
afterEach(() => db.close());
const reservations = () => db.prepare("SELECT state, chapter_id AS chapterId, llm_tokens AS reserved, provider_request_id AS requestId FROM budget_reservations ORDER BY rowid").all() as { state: string; chapterId: string; reserved: number; requestId: string | null }[];
const run = (provider: StubLlmProvider, patch: Partial<Parameters<typeof adaptChapter>[0]> = {}) => adaptChapter({ provider, ledger, input: INPUT, bookId: "b1", chapterId: "c2", delay: noDelay, ...patch });

describe("adaptChapter", () => {
  it("makes one structured, budgeted request and returns the checked Script with the pipeline's ids", async () => {
    const provider = new StubLlmProvider(() => JSON.stringify(GOOD));
    const r = await run(provider);
    expect(r).toMatchObject({ ok: true, providerId: "stub", requestId: "stub-1", script: { bookId: "b1", chapterId: "c2", episodeNumber: 2, scenes: [{ id: "castle" }] } });
    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.jsonSchema.name).toBe("radio_script");
    expect(JSON.stringify(req.jsonSchema.schema)).not.toMatch(/"minItems"|"maxLength"|"\$schema"/);
    expect(req.user).toContain(`<chapter_text>\n${TEXT}\n</chapter_text>`);
    expect(req.maxOutputTokens).toBe(adaptationOutputTokens(TEXT));
    expect(reservations()).toEqual([{ state: "settled", chapterId: "c2", reserved: expect.any(Number), requestId: "stub-1" }]);
  });

  it("returns the problems with a reply that breaks the rules, ready to send back", async () => {
    const bad = { ...GOOD, close: [{ kind: "announcer", text: "Goodnight." }, { kind: "music", cue: "theme" }] };
    const r = await run(new StubLlmProvider(() => JSON.stringify(bad)));
    expect(r).toEqual({ ok: false, providerId: "stub", requestId: "stub-1", issues: [{ path: "close", message: 'the announcer\'s close must end with "Tune in next time to Midnight Radio."' }] });
    // The model still did the work, so the call stays counted.
    expect(reservations()[0]!.state).toBe("settled");
  });

  it("refuses a reply that is not JSON or not a Script", async () => {
    expect(await run(new StubLlmProvider(() => "Sure! Here is the script."))).toMatchObject({ ok: false, issues: [{ path: "(reply)", message: "the reply was not valid JSON" }] });
    expect(await run(new StubLlmProvider(() => JSON.stringify({ ...GOOD, episodeNumber: 9 })))).toMatchObject({ ok: false });
  });

  it("checks the uncertain-speaker fallback against the chapter text (Task 7.3)", async () => {
    const withQuote = (text: string) => ({ ...GOOD, scenes: [{ id: "castle", segments: [{ kind: "narration", text: "A voice greets him." }, { kind: "narration", containsVerbatimQuote: true, text }] }] });
    expect((await run(new StubLlmProvider(() => JSON.stringify(withQuote("Welcome to my house!"))))).ok).toBe(true);
    const bad = await run(new StubLlmProvider(() => JSON.stringify(withQuote("Jonathan Harker reached the castle."))));
    expect(bad).toMatchObject({ ok: false, issues: [{ path: "scenes[0].segments[1]", message: expect.stringContaining("not a whole quotation") }] });
  });

  it("sends earlier problems back as feedback after the chapter", async () => {
    const provider = new StubLlmProvider(() => JSON.stringify(GOOD));
    await run(provider, { feedback: [{ path: "scenes[0].segments[3]", message: "narration has 40 words; condense it" }] });
    const user = provider.requests[0]!.user;
    expect(user.indexOf("</chapter_text>")).toBeLessThan(user.indexOf("Your previous script was not accepted."));
    expect(user).toContain("- scenes[0].segments[3]: narration has 40 words; condense it");
  });

  it("retries transient provider errors with back-off, but not other failures", async () => {
    const waits: number[] = [];
    const flaky = new StubLlmProvider((_req, call) => {
      if (call < 3) throw new LlmError("rate limited", false, true, 429);
      return JSON.stringify(GOOD);
    });
    expect((await run(flaky, { delay: async (ms) => void waits.push(ms) })).ok).toBe(true);
    expect(waits).toEqual([1000, 2000]);
    expect(reservations().map((r) => r.state)).toEqual(["released", "released", "settled"]);

    const denied = new StubLlmProvider(() => {
      throw new LlmError("bad key", false, false, 401);
    });
    await expect(run(denied)).rejects.toMatchObject({ status: 401 });
    expect(denied.requests).toHaveLength(1);

    const down = new StubLlmProvider(() => {
      throw new LlmError("timeout", true, true);
    });
    await expect(run(down, { maxTransientAttempts: 2 })).rejects.toThrow("timeout");
    expect(down.requests).toHaveLength(2);
  });

  it("refuses to call the model when LLM calls are disabled, and checks the lease inside the reservation", async () => {
    const provider = new StubLlmProvider(() => JSON.stringify(GOOD));
    await expect(adaptChapter({ provider, ledger: new BudgetLedger(db, { ...CFG, dailyLlmTokens: 0 }), input: INPUT, bookId: "b1", chapterId: "c2", delay: noDelay })).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(run(provider, { fence: () => { throw new Error("lease lost"); } })).rejects.toThrow("lease lost");
    expect(provider.requests).toHaveLength(0);
  });

  it("stops before calling when the job is aborted", async () => {
    const provider = new StubLlmProvider(() => JSON.stringify(GOOD));
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(run(provider, { signal: ctrl.signal })).rejects.toThrow();
    expect(provider.requests).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("sizes the output allowance from the chapter, within bounds", () => {
    expect(adaptationOutputTokens("short")).toBe(4_000);
    expect(adaptationOutputTokens("x".repeat(30_000))).toBe(Math.ceil((30_000 / 3) * 1.2) + 2_000);
    expect(adaptationOutputTokens("x".repeat(500_000))).toBe(32_000);
  });

  it("limits the feedback it sends", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ path: `p${i}`, message: "m" }));
    const text = feedbackText(many);
    expect(text.match(/^- /gm)).toHaveLength(20);
    expect(text).toContain("(and 5 more of the same kinds)");
  });
});
