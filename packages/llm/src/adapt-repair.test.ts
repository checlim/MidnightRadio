import type { DatabaseSync } from "node:sqlite";
import { parseQuotes, quoteUnits, type AdaptedScript, type ValidationInput } from "@midnight-radio/core";
import { BudgetExceededError, BudgetLedger, openDb, type BudgetConfig } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdaptationInput } from "./adapt-prompt.js";
import { MAX_REPAIRS, adaptWithRepair } from "./adapt-repair.js";
import { StubLlmProvider } from "./stub.js";

const TEXT = `The door opened. \u201cWelcome to my house!\u201d said the Count. \u201cCount Dracula?\u201d I asked. A wolf howled.`;
const INPUT: AdaptationInput = {
  book: { title: "Dracula", author: "Bram Stoker" },
  chapter: { idx: 1, title: "II", part: 1, partCount: 1, canonicalText: TEXT },
  episodeNumber: 2,
  cast: [
    { name: "Count Dracula", aliases: ["the Count"], genderPresentation: "masculine", description: null, speaks: true },
    { name: "Jonathan Harker", aliases: [], genderPresentation: "masculine", description: null, speaks: true },
  ],
  sfx: { version: 1, id: "lib", entries: [{ id: "main_theme", kind: "music", title: "Theme", path: "music/t.wav", sha256: "a".repeat(64), durationMs: 20_000, loopable: false, peakDb: -1, tags: [], source: { type: "project", author: "x", licence: "CC0-1.0" } }], musicCues: { theme: "main_theme" } },
  styleGuide: "# Style",
};
const parse = parseQuotes(TEXT);
const VALIDATION: Omit<ValidationInput, "script" | "episode"> = {
  sourceText: TEXT,
  canonicalText: TEXT,
  quoteParse: parse,
  quotes: quoteUnits(parse),
  cast: [
    { name: "Announcer", role: "announcer", speaks: true },
    { name: "Narrator", role: "narrator", speaks: true },
    { name: "Count Dracula", role: "character", speaks: true },
    { name: "Jonathan Harker", role: "character", speaks: true },
  ],
  sfx: INPUT.sfx,
};
const reply = (dialogue: { speaker: string; text: string }[], patch: Partial<AdaptedScript> = {}): string =>
  JSON.stringify({
    coldOpen: [{ kind: "announcer", text: "Midnight Radio presents Episode 2." }],
    scenes: [{ id: "door", segments: [{ kind: "narration", text: "The door opens." }, ...dialogue.map((d) => ({ kind: "dialogue" as const, ...d }))] }],
    close: [{ kind: "announcer", text: "Tune in next time to Midnight Radio." }, { kind: "music", cue: "theme" }],
    ...patch,
  } satisfies AdaptedScript);
const GOOD = reply([{ speaker: "Count Dracula", text: "Welcome to my house!" }, { speaker: "Jonathan Harker", text: "Count Dracula?" }]);
const MISSING = reply([{ speaker: "Count Dracula", text: "Welcome to my house!" }]);
const INVENTED = reply([{ speaker: "Count Dracula", text: "Welcome to my castle!" }, { speaker: "Jonathan Harker", text: "Count Dracula?" }]);
const BROKEN_CLOSE = reply([{ speaker: "Count Dracula", text: "Welcome to my house!" }], { close: [{ kind: "announcer", text: "Goodnight." }, { kind: "music", cue: "theme" }] });

const CFG: BudgetConfig = { dailyTtsChars: 0, dailyLlmTokens: 1_000_000, bookTtsCharCeiling: 60_000 };
let db: DatabaseSync;
let ledger: BudgetLedger;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'Dracula', 'h', 'ready', 0)").run();
  db.prepare("INSERT INTO chapters (id, book_id, idx, title, source_text, canonical_text, word_count, status) VALUES ('c2', 'b1', 1, 'II', 's', 's', 1, 'ready')").run();
  ledger = new BudgetLedger(db, CFG);
});
afterEach(() => db.close());
const scripted = (...replies: string[]) => new StubLlmProvider((_req, call) => replies[Math.min(call, replies.length) - 1]!);
const run = (provider: StubLlmProvider, patch: Partial<Parameters<typeof adaptWithRepair>[0]> = {}) =>
  adaptWithRepair({ provider, ledger, input: INPUT, validation: VALIDATION, bookId: "b1", chapterId: "c2", delay: async () => undefined, ...patch });

describe("adaptWithRepair", () => {
  it("returns the first attempt that passes, with its report", async () => {
    const provider = scripted(GOOD);
    const out = await run(provider);
    expect(out).toMatchObject({ status: "valid", report: { ok: true, fidelity: 1 }, attempts: [{ attempt: 1, issues: [] }], providerId: "stub" });
    expect(provider.requests).toHaveLength(1);
  });

  it("repairs with the gate's problems: missing quotations and invented lines are sent back", async () => {
    const provider = scripted(MISSING, INVENTED, GOOD);
    const out = await run(provider);
    expect(out.status).toBe("valid");
    expect(out.attempts.map((a) => [a.attempt, a.report?.ok ?? null])).toEqual([[1, false], [2, false], [3, true]]);
    const second = provider.requests[1]!.user;
    expect(second).toContain('this quotation from the chapter is missing, include it word for word: "Count Dracula?"');
    const third = provider.requests[2]!.user;
    expect(third).toContain("this line is not a quotation from the chapter; dialogue must be copied word for word");
    expect(third).toContain('missing, include it word for word: "Welcome to my house!"');
    // each repair sends only the latest problems
    expect(third).not.toContain('"Count Dracula?"');
  });

  it("repairs a reply that broke a rule before validation", async () => {
    const provider = scripted(BROKEN_CLOSE, GOOD);
    const out = await run(provider);
    expect(out.status).toBe("valid");
    expect(out.attempts[0]).toMatchObject({ attempt: 1, script: null, report: null, issues: [{ path: "close" }] });
    expect(provider.requests[1]!.user).toContain('- close: the announcer\'s close must end with "Tune in next time to Midnight Radio."');
  });

  it("fails closed after one attempt and two repairs, keeping every attempt", async () => {
    const provider = scripted(MISSING, "not json", INVENTED, GOOD);
    const out = await run(provider);
    expect(out).toMatchObject({ status: "failed", reason: "attempts_exhausted" });
    expect(out.attempts).toHaveLength(1 + MAX_REPAIRS);
    expect(provider.requests).toHaveLength(3);
    expect(out.attempts.map((a) => a.script === null)).toEqual([false, true, false]);
  });

  it("never allows more than two repairs, and can be told to make fewer", async () => {
    expect((await run(scripted(MISSING), { maxRepairs: 9 })).attempts).toHaveLength(3);
    const once = scripted(MISSING);
    expect((await run(once, { maxRepairs: 0 })).attempts).toHaveLength(1);
    expect(once.requests).toHaveLength(1);
  });

  it("fails a chapter whose quotations could not be read without calling the model", async () => {
    const amb = parseQuotes("He said \u201cHello. And then \u201cBye.\u201d");
    const provider = scripted(GOOD);
    const out = await run(provider, { validation: { ...VALIDATION, quoteParse: amb, quotes: quoteUnits(amb) } });
    expect(out).toMatchObject({ status: "failed", reason: "unreadable_quotes", attempts: [] });
    expect(out.status === "failed" && out.message).toMatch(/needs manual review/);
    expect(provider.requests).toHaveLength(0);
  });

  it("stops at once on a budget refusal: that is not something a repair can fix", async () => {
    const off = new BudgetLedger(db, { ...CFG, dailyLlmTokens: 0 });
    await expect(run(scripted(GOOD), { ledger: off })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("budgets every attempt separately", async () => {
    await run(scripted(MISSING, INVENTED, GOOD));
    expect((db.prepare("SELECT COUNT(*) AS n FROM budget_reservations WHERE chapter_id = 'c2' AND state = 'settled'").get() as { n: number }).n).toBe(3);
  });
});
