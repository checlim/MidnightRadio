import type { DatabaseSync } from "node:sqlite";
import { BudgetExceededError, BudgetLedger, openDb } from "@midnight-radio/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubLlmProvider } from "./stub.js";
import { BRIEF_BATCH, VoiceBriefError, briefProblem, checkBriefReply, writeVoiceBriefs, type BriefCharacter } from "./voice-briefs.js";

const ch = (name: string): BriefCharacter => ({ name, aliases: [], genderPresentation: "masculine", ageBand: "older", description: `${name} appears.` });
const good = (name: string) => ({ name, brief: `An older man's voice, low and slow, with a dry courtly warmth, for ${name}.` });

let db: DatabaseSync;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO books (id, title, source_hash, status, created_at) VALUES ('b1', 'Dracula', 'h', 'ready', 0)").run();
});
afterEach(() => db.close());
const ledger = (tokens = 1_000_000) => new BudgetLedger(db, { dailyTtsChars: 0, dailyLlmTokens: tokens, bookTtsCharCeiling: 60_000 });
const names = (user: string) => [...user.matchAll(/^- (.+?)(?:;.*)?$/gm)].map((m) => m[1]!);

describe("voice briefs", () => {
  it("refuses briefs that are too short or long, compare the voice to someone, or carry a link", () => {
    expect(briefProblem("An older man's voice, low and slow.")).toBeNull();
    expect(briefProblem("A voice of middle pitch, clear and even, never hurried.")).toBeNull();
    expect(briefProblem("Low.")).toMatch(/shorter than 20/);
    expect(briefProblem("x".repeat(301))).toMatch(/longer than 300/);
    for (const b of ["Sounds like a famous film actor, deep and slow.", "Deep and slow, in the style of an old radio star.", "An impression of a well-known singer's speaking voice.", "Imitating a celebrity, low and smooth and warm.", "Reminiscent of a certain actor, gravelly and slow.", "Deep voice, see https://example.com for a sample."]) {
      expect([b, briefProblem(b)]).toEqual([b, expect.any(String)]);
    }
  });

  it("checks a reply against the characters asked for: every name once, matched as the cast matches names", () => {
    const batch = [ch("Count Dracula"), ch("Jonathan Harker")];
    expect(checkBriefReply(JSON.stringify({ voices: [good("count dracula"), good("Jonathan Harker")] }), batch)).toEqual({ ok: true, briefs: new Map([["Count Dracula", good("count dracula").brief], ["Jonathan Harker", good("Jonathan Harker").brief]]) });
    const bad = checkBriefReply(JSON.stringify({ voices: [good("Count Dracula"), good("Count Dracula"), good("Renfield"), { name: "Jonathan Harker", brief: "Sounds like a famous actor, young and eager." }] }), batch);
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('"Count Dracula" appears twice') });
    expect(!bad.ok && bad.error).toMatch(/"Renfield" is not one of the characters listed/);
    expect(!bad.ok && bad.error).toMatch(/the brief for "Jonathan Harker" compares the voice to someone/);
    expect(checkBriefReply(JSON.stringify({ voices: [good("Count Dracula")] }), batch)).toEqual({ ok: false, error: '"Jonathan Harker" is missing' });
    expect(checkBriefReply("not json", batch)).toEqual({ ok: false, error: "it was not JSON" });
  });

  it("asks in batches, metered, and sends back what was wrong until the reply is usable", async () => {
    const characters = Array.from({ length: BRIEF_BATCH + 3 }, (_, i) => ch(`Person ${String(i).padStart(2, "0")}`));
    let first = true;
    const provider = new StubLlmProvider((req) => {
      const listed = names(req.user);
      if (first) {
        first = false;
        return JSON.stringify({ voices: listed.slice(1).map(good) }); // forgets one
      }
      return JSON.stringify({ voices: listed.map(good) });
    });
    const l = ledger();
    const briefs = await writeVoiceBriefs({ provider, ledger: l, bookId: "b1", book: { title: "Dracula", author: "Bram Stoker" }, characters, delay: async () => undefined });
    expect(briefs.size).toBe(characters.length);
    expect(provider.requests.map((r) => names(r.user.split("\n\n")[0]!).length)).toEqual([BRIEF_BATCH, BRIEF_BATCH, 3]);
    expect(provider.requests[1]!.user).toContain('"Person 00" is missing');
    expect(provider.requests[0]!.system).toMatch(/Never name or compare to a real person/);
    expect(provider.requests[0]!.user).toContain('Book: "Dracula" by Bram Stoker.');
    expect(l.daySpend().llmTokens).toBeGreaterThan(0);
  });

  it("gives up with a clear error after repeated bad replies, and stops at once when the budget is out", async () => {
    const never = new StubLlmProvider(() => JSON.stringify({ voices: [] }));
    await expect(writeVoiceBriefs({ provider: never, ledger: ledger(), bookId: "b1", book: { title: "D", author: null }, characters: [ch("A Person")], delay: async () => undefined })).rejects.toThrow(VoiceBriefError);
    expect(never.requests).toHaveLength(3);
    const any = new StubLlmProvider(() => JSON.stringify({ voices: [good("A Person")] }));
    await expect(writeVoiceBriefs({ provider: any, ledger: ledger(10), bookId: "b1", book: { title: "D", author: null }, characters: [ch("A Person")] })).rejects.toThrow(BudgetExceededError);
    expect(any.requests).toHaveLength(0);
  });
});
