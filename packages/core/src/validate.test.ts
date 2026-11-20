import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EpisodeInfo } from "./adaptation.js";
import { parseQuotes } from "./quotes.js";
import type { Script } from "./schema.js";
import type { SfxCatalogue } from "./sfx.js";
import { FIDELITY_THRESHOLD, alignQuotes, quoteUnits, quoteUnitsForPart, repairFeedback, speechSegments, validateScript, type ValidationCastMember, type ValidationInput } from "./validate.js";

describe("alignQuotes", () => {
  it("matches one segment per quote, in order", () => {
    expect(alignQuotes(["A b.", "C d."], ["A b.", "C d."])).toEqual({ matches: [{ quote: 0, segments: [0] }, { quote: 1, segments: [1] }], unmatchedQuotes: [], unmatchedSegments: [] });
  });

  it("lets one quote span adjacent segments, and one segment say consecutive quotes", () => {
    expect(alignQuotes(["One two. Three four."], ["One two.", "Three four."]).matches).toEqual([{ quote: 0, segments: [0, 1] }]);
    expect(alignQuotes(["Welcome,", "to my house."], ["Welcome, to my house."]).matches).toEqual([{ quote: 0, segments: [0] }, { quote: 1, segments: [0] }]);
  });

  it("reports quotes left out and segments that match nothing", () => {
    const a = alignQuotes(["A.", "B.", "C."], ["A.", "X.", "C."]);
    expect(a.unmatchedQuotes).toEqual([1]);
    expect(a.unmatchedSegments).toEqual([1]);
    expect(a.matches.map((m) => m.quote)).toEqual([0, 2]);
  });

  it("uses each source occurrence and each segment once: a replayed line is a stray", () => {
    const a = alignQuotes(["Hello.", "Bye."], ["Hello.", "Hello.", "Bye."]);
    expect(a.matches.map((m) => [m.quote, m.segments])).toEqual([[0, [0]], [1, [2]]]);
    expect(a.unmatchedSegments).toEqual([1]);
    // repeated source quotes consume separate segments
    expect(alignQuotes(["Yes.", "Yes."], ["Yes.", "Yes."]).unmatchedQuotes).toEqual([]);
    expect(alignQuotes(["Yes.", "Yes."], ["Yes."]).unmatchedQuotes).toEqual([1]);
  });

  it("finds the most matches even when a greedy order would not", () => {
    // Greedy matching "B." to the first segment would lose two quotes.
    const a = alignQuotes(["A.", "B.", "C."], ["B.", "A.", "B.", "C."]);
    expect(a.matches.map((m) => m.quote)).toEqual([0, 1, 2]);
    expect(a.unmatchedSegments).toEqual([0]);
  });

  it("never matches out of order", () => {
    expect(alignQuotes(["A.", "B."], ["B.", "A."]).matches).toHaveLength(1);
  });

  it("property: a Script that says every quote, however split or joined, matches them all with nothing left over", () => {
    const quote = fc.array(fc.stringMatching(/^[A-Za-z]{1,6}$/), { minLength: 1, maxLength: 6 }).map((w) => `${w.join(" ")}.`);
    fc.assert(
      fc.property(fc.array(quote, { minLength: 1, maxLength: 12 }), fc.infiniteStream(fc.integer({ min: 0, max: 2 })), (quotes, choices) => {
        const it = choices[Symbol.iterator]();
        const segments: string[] = [];
        for (let i = 0; i < quotes.length; i++) {
          const c = it.next().value as number;
          const words = quotes[i]!.split(" ");
          if (c === 1 && words.length > 1) segments.push(words.slice(0, 1).join(" "), words.slice(1).join(" ")); // split
          else if (c === 2 && i + 1 < quotes.length) segments.push(`${quotes[i]} ${quotes[++i]}`); // joined
          else segments.push(quotes[i]!);
        }
        const a = alignQuotes(quotes, segments);
        expect(a.unmatchedQuotes).toEqual([]);
        expect(a.unmatchedSegments).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

const CHAPTER = `The door opened. A tall old man stood there.
\u201cWelcome to my house!\u201d he said. \u201cEnter freely and of your own will!\u201d
I hesitated. \u201cCount Dracula?\u201d I asked.
\u201cI am Dracula; and I bid you welcome, Mr. Harker, to my house.\u201d
A wolf howled.`;
const SFX: SfxCatalogue = { version: 1, id: "lib", entries: [{ id: "wolves_howling", kind: "sfx", title: "Wolves", path: "foley/w.wav", sha256: "a".repeat(64), durationMs: 5000, loopable: false, peakDb: -1, tags: [], source: { type: "project", author: "x", licence: "CC0-1.0" } }, { id: "main_theme", kind: "music", title: "Theme", path: "music/t.wav", sha256: "b".repeat(64), durationMs: 20_000, loopable: false, peakDb: -1, tags: [], source: { type: "project", author: "x", licence: "CC0-1.0" } }], musicCues: { theme: "main_theme" } };
const EPISODE: EpisodeInfo = { bookId: "dracula", chapterId: "c2", episodeNumber: 2, seriesTitle: "Midnight Radio", chapterTitle: "II" };
const CAST: ValidationCastMember[] = [
  { name: "Announcer", role: "announcer" as const, speaks: true },
  { name: "Narrator", role: "narrator" as const, speaks: true },
  { name: "Count Dracula", role: "character" as const, speaks: true },
  { name: "Jonathan Harker", role: "character" as const, speaks: true },
  { name: "The landlady", role: "character" as const, speaks: false },
];
const script = (segments: Script["scenes"][number]["segments"], patch: Partial<Script> = {}): Script => ({
  bookId: "dracula",
  chapterId: "c2",
  episodeNumber: 2,
  coldOpen: [{ kind: "announcer", text: "Midnight Radio. Episode 2." }],
  scenes: [{ id: "castle", segments }],
  close: [{ kind: "announcer", text: "Tune in next time to Midnight Radio." }, { kind: "music", cue: "theme" }],
  ...patch,
});
const ALL_SPOKEN: Script["scenes"][number]["segments"] = [
  { kind: "narration", text: "The door opens on a tall old man." },
  { kind: "dialogue", speaker: "Count Dracula", text: "Welcome to my house!" },
  { kind: "dialogue", speaker: "Count Dracula", text: "Enter freely and of your own will!" },
  { kind: "dialogue", speaker: "Jonathan Harker", text: "Count Dracula?" },
  { kind: "dialogue", speaker: "the Count", text: "I am Dracula; and I bid you welcome, Mr. Harker, to my house." },
  { kind: "sfx", sfxId: "wolves_howling" },
];
const parse = parseQuotes(CHAPTER);
const input = (s: Script, patch: Partial<ValidationInput> = {}): ValidationInput => ({
  script: s,
  episode: EPISODE,
  sourceText: CHAPTER,
  canonicalText: CHAPTER,
  quoteParse: parse,
  quotes: quoteUnits(parse),
  cast: [...CAST, { name: "the Count", role: "character", speaks: true } satisfies ValidationCastMember],
  sfx: SFX,
  ...patch,
});

describe("validateScript", () => {
  it("passes a faithful Script and records versions, hashes and counts", () => {
    const r = validateScript(input(script(ALL_SPOKEN)));
    expect(r).toMatchObject({ ok: true, fidelity: 1, threshold: FIDELITY_THRESHOLD, validatorVersion: "validate-1", parserVersion: "quotes-2", normaliserVersion: "norm-1", counts: { sourceQuotes: 4, speechQuotes: 4, matchedSpeechQuotes: 4, terms: 0, matchedTerms: 0, speechSegments: 4, unmatchedSegments: 0 }, missingQuotes: [], unvoicedTerms: [], reverseErrors: [], issues: [] });
    expect(r.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateScript(input(script(ALL_SPOKEN))).scriptSha256).toBe(r.scriptSha256);
    expect(validateScript(input(script(ALL_SPOKEN.slice(0, 5)))).scriptSha256).not.toBe(r.scriptSha256);
  });

  it("tolerates missing quotes down to the threshold, and reports them", () => {
    const three = ALL_SPOKEN.filter((s) => !(s.kind === "dialogue" && s.text === "Count Dracula?"));
    const r = validateScript(input(script(three)));
    expect(r.fidelity).toBe(0.75);
    expect(r.ok).toBe(false);
    expect(r.missingQuotes).toEqual([{ id: "q3", text: "Count Dracula?" }]);
  });

  it("fails on any invented, partial or replayed speech, whatever the fidelity", () => {
    const extra = (seg: Script["scenes"][number]["segments"][number]) => validateScript(input(script([...ALL_SPOKEN, seg])));
    expect(extra({ kind: "dialogue", speaker: "Count Dracula", text: "I never drink... wine." })).toMatchObject({ ok: false, fidelity: 1, reverseErrors: [{ kind: "invented" }] });
    expect(extra({ kind: "dialogue", speaker: "Count Dracula", text: "Welcome to my house!" }).reverseErrors[0]!.kind).toBe("duplicated");
    expect(extra({ kind: "dialogue", speaker: "Count Dracula", text: "bid you welcome" }).reverseErrors[0]!.kind).toBe("partial");
    // a reworded line is both a missing quote and an invented one
    const reworded = ALL_SPOKEN.map((s) => (s.kind === "dialogue" && s.text === "Count Dracula?" ? { ...s, text: "Are you Count Dracula?" } : s));
    expect(validateScript(input(script(reworded)))).toMatchObject({ ok: false, missingQuotes: [{ id: "q3" }], reverseErrors: [{ kind: "invented" }] });
  });

  it("scores speech only: terms left out cost nothing and are listed; voiced terms still match", () => {
    const src = `${CHAPTER}\nHe called the dish \u201crobber steak\u201d and the hill \u201cIsten szek\u201d.`;
    const p = parseQuotes(src);
    expect(p.quotes.filter((q) => q.kind === "term").map((q) => q.text)).toEqual(["robber steak", "Isten szek"]);
    const base = { sourceText: src, canonicalText: src, quoteParse: p, quotes: quoteUnits(p) };
    const without = validateScript(input(script(ALL_SPOKEN), base));
    expect(without).toMatchObject({ ok: true, fidelity: 1, counts: { sourceQuotes: 6, speechQuotes: 4, terms: 2, matchedTerms: 0 }, missingQuotes: [], unvoicedTerms: [{ text: "robber steak" }, { text: "Isten szek" }] });
    const voiced = validateScript(input(script([...ALL_SPOKEN, { kind: "narration", containsVerbatimQuote: true, text: "robber steak" }]), base));
    expect(voiced).toMatchObject({ ok: true, counts: { matchedTerms: 1 }, unvoicedTerms: [{ text: "Isten szek" }], reverseErrors: [] });
  });

  it("gives fidelity 1 when a chapter has only terms", () => {
    const src = "He spoke of the \u201cRed Death\u201d once.";
    const p = parseQuotes(src);
    expect(validateScript(input(script([{ kind: "narration", text: "He speaks of a plague." }]), { sourceText: src, canonicalText: src, quoteParse: p, quotes: quoteUnits(p) }))).toMatchObject({ ok: true, fidelity: 1 });
  });

  it("accepts the uncertain-speaker fallback and counts it as matched", () => {
    const fallback = ALL_SPOKEN.map((s) => (s.kind === "dialogue" && s.text === "Count Dracula?" ? { kind: "narration" as const, containsVerbatimQuote: true, text: "Count Dracula?" } : s));
    expect(validateScript(input(script(fallback)))).toMatchObject({ ok: true, fidelity: 1 });
  });

  it("checks speakers against the Cast", () => {
    const by = (speaker: string) => validateScript(input(script(ALL_SPOKEN.map((s) => (s.kind === "dialogue" && s.text === "Count Dracula?" ? { ...s, speaker } : s))))).issues.map((i) => i.message);
    expect(by("jonathan harker")).toEqual([]); // matched by name key
    expect(by("Mina Harker")).toEqual(['speaker "Mina Harker" is not in the Cast; use a Cast name, or put the quotation in narration marked as a verbatim quote']);
    expect(by("The landlady")[0]).toMatch(/never speaks in the Cast/);
    expect(by("Narrator")[0]).toMatch(/cannot speak dialogue/);
    expect(by("Announcer")[0]).toMatch(/cannot speak dialogue/);
  });

  it("includes the sound audit and the adaptation rules", () => {
    const r = validateScript(input(script([...ALL_SPOKEN, { kind: "sfx", sfxId: "lightning" }], { close: [{ kind: "announcer", text: "Goodnight." }, { kind: "music", cue: "theme" }] })));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.path)).toEqual(["close", "scenes[0].segments[6]"]);
  });

  it("fails closed when the source quotes could not be read", () => {
    const amb = parseQuotes("He said \u201cHello. And then \u201cBye.\u201d");
    const r = validateScript(input(script(ALL_SPOKEN), { quoteParse: amb, quotes: quoteUnits(amb) }));
    expect(r).toMatchObject({ ok: false, fidelity: null, quoteParse: { status: "ambiguous" } });
    expect(r.issues.at(-1)!.message).toMatch(/needs manual review/);
  });

  it("gives fidelity 1 to a quote-free chapter, but no speech may be added", () => {
    const quiet = "The house was silent. Nothing moved.";
    const p = parseQuotes(quiet);
    const base = { sourceText: quiet, canonicalText: quiet, quoteParse: p, quotes: quoteUnits(p) };
    expect(validateScript(input(script([{ kind: "narration", text: "The house is silent." }]), base))).toMatchObject({ ok: true, fidelity: 1 });
    expect(validateScript(input(script([{ kind: "dialogue", speaker: "Count Dracula", text: "Hello." }]), base))).toMatchObject({ ok: false, fidelity: 1, reverseErrors: [{ kind: "invented" }] });
  });

  it("builds repair feedback from every problem, with missing quotes capped", () => {
    const r = validateScript(input(script([ALL_SPOKEN[0]!, { kind: "dialogue", speaker: "Count Dracula", text: "Hi." }])));
    const fb = repairFeedback(r, 2);
    expect(fb.map((f) => f.path)).toEqual(["scenes[0].segments[1]", "(missing q1)", "(missing q2)", "(missing)"]);
    expect(fb[1]!.message).toBe('this quotation from the chapter is missing, include it word for word: "Welcome to my house!"');
    expect(fb[3]!.message).toBe("and 2 more quotations are missing");
  });
});

describe("split chapters", () => {
  it("cuts quotes to a part and flags the ones that cross its boundary", () => {
    const src = "Intro. \u201cFirst words.\u201d Then \u201cSecond part one\n\n\u201cand second part two.\u201d End.";
    const p = parseQuotes(src);
    const boundary = src.indexOf("\n\n");
    expect(quoteUnitsForPart(p, src, 0, boundary)).toEqual([
      { id: "q1", kind: "speech", text: "First words.", continuesFromPrevious: false, continuesIntoNext: false },
      { id: "q2", kind: "speech", text: "Second part one", continuesFromPrevious: false, continuesIntoNext: true },
    ]);
    expect(quoteUnitsForPart(p, src, boundary, src.length)).toEqual([{ id: "q2", kind: "speech", text: "and second part two.", continuesFromPrevious: true, continuesIntoNext: false }]);
  });
});

describe("split chapters: kinds", () => {
  it("keeps each quote's kind in a part", () => {
    const src = "He named the \u201cRed Death\u201d and said, \u201cBeware.\u201d";
    expect(quoteUnitsForPart(parseQuotes(src), src, 0, src.length).map((u) => [u.text, u.kind])).toEqual([["Red Death", "term"], ["Beware.", "speech"]]);
  });
});

describe("speechSegments", () => {
  it("takes dialogue and marked narration, in Script order, with their paths", () => {
    const s = speechSegments(script([{ kind: "narration", text: "x" }, { kind: "dialogue", speaker: "A", text: "\u201cHi.\u201d" }, { kind: "narration", containsVerbatimQuote: true, text: "Who?" }]));
    expect(s.map((x) => [x.path, x.kind, x.text])).toEqual([["scenes[0].segments[1]", "dialogue", "Hi."], ["scenes[0].segments[2]", "narration", "Who?"]]);
  });
});
