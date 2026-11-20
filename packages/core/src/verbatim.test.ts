import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkAdaptationReply, type AdaptedScript } from "./adaptation.js";
import { normaliseForComparison } from "./normalise.js";
import { checkVerbatimQuotes, quoteBody, verbatimQuoteProblem } from "./verbatim.js";

// Curly quotes as in the Standard Ebooks texts; a quote broken by "he said"; a quotation over two
// paragraphs (the first has no closing mark, the second reopens); an unattributed shout.
const CHAPTER = `The door opened. Within stood a tall old man.
\u201cWelcome to my house!\u201d he said, \u201cEnter freely and of your own will!\u201d
I hesitated, and he went on:
\u201cThe road is long and the night is cold.
\u201cCome, sit by the fire.\u201d
From somewhere below a voice cried out, \u201cWho goes there?\u201d
The wolves howled.`;
const comparison = normaliseForComparison(CHAPTER);
const problem = (text: string) => verbatimQuoteProblem(text, comparison);

describe("verbatimQuoteProblem", () => {
  it("accepts a whole quotation, with or without its quote marks, curly or straight", () => {
    expect(problem("Who goes there?")).toBeNull();
    expect(problem("\u201cWho goes there?\u201d")).toBeNull();
    expect(problem('"Who goes there?"')).toBeNull();
    expect(problem("  Who  goes\nthere? ")).toBeNull();
  });

  it("accepts each piece of a quotation the text itself breaks, and each paragraph of a long one", () => {
    expect(problem("Welcome to my house!")).toBeNull();
    expect(problem("Enter freely and of your own will!")).toBeNull();
    expect(problem("The road is long and the night is cold.")).toBeNull(); // paragraph without a closing mark
    expect(problem("Come, sit by the fire.")).toBeNull();
  });

  it("refuses a lead-in attached to the quote", () => {
    expect(problem('From somewhere below a voice cried out, "Who goes there?"')).toBe("several_quotes");
    expect(problem("a voice cried out, Who goes there?")).toBe("not_in_text");
  });

  it("refuses part of a quotation, narration marked as a quote, and altered words", () => {
    expect(problem("Who goes")).toBe("not_a_quotation");
    expect(problem("The wolves howled.")).toBe("not_a_quotation");
    expect(problem("Welcome to my home!")).toBe("not_in_text");
    expect(problem("Who goes there")).toBe("not_a_quotation"); // the question mark is part of the quote
  });

  it("refuses several quotations in one segment, and an empty one", () => {
    expect(problem("\u201cWelcome to my house!\u201d \u201cEnter freely and of your own will!\u201d")).toBe("several_quotes");
    expect(problem("Welcome to my house!\u201d he said, \u201cEnter freely and of your own will!")).toBe("several_quotes");
    expect(problem('""')).toBe("empty");
    expect(problem("   ")).toBe("empty");
  });

  it("finds the right occurrence when the words appear both inside and outside quotes", () => {
    const text = normaliseForComparison(`Night fell. He whispered, \u201cNight fell.\u201d`);
    expect(verbatimQuoteProblem("Night fell.", text)).toBeNull();
  });

  it("tells opening from closing marks, so text right after a quotation is not taken for one", () => {
    const text = normaliseForComparison(`\u201cGo!\u201d Silence fell. \u201cNow.\u201d`);
    expect(verbatimQuoteProblem("Silence fell.", text)).toBe("not_a_quotation");
    expect(verbatimQuoteProblem("Go!", text)).toBeNull();
    expect(verbatimQuoteProblem("Now.", text)).toBeNull();
    expect(verbatimQuoteProblem("Ask (\u201cwhy?\u201d) later", normaliseForComparison("Ask (\u201cwhy?\u201d) later"))).toBe("several_quotes");
    expect(verbatimQuoteProblem("why?", normaliseForComparison("Ask (\u201cwhy?\u201d) later"))).toBeNull();
  });

  it("strips only the quote marks and spaces at the ends", () => {
    expect(quoteBody(' \u201c It\u2019s late.\u201d ')).toBe("It's late.");
  });

  it("property: any whole quotation of generated text is accepted, and the same words with a lead-in are not", () => {
    const word = fc.stringMatching(/^[a-z]{1,8}$/);
    const sentence = fc.array(word, { minLength: 1, maxLength: 12 }).map((w) => `${w.join(" ")}.`);
    fc.assert(
      fc.property(sentence, sentence, sentence, (before, quoted, after) => {
        const text = normaliseForComparison(`${before} \u201c${quoted}\u201d ${after}`);
        expect(verbatimQuoteProblem(quoted, text)).toBeNull();
        expect(verbatimQuoteProblem(`${before} ${quoted}`, text)).not.toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});

describe("checkVerbatimQuotes and the adapter reply", () => {
  const reply = (segments: AdaptedScript["scenes"][number]["segments"]): AdaptedScript => ({
    coldOpen: [{ kind: "announcer", text: "Midnight Radio. Episode 2." }],
    scenes: [{ id: "s1", segments }],
    close: [{ kind: "announcer", text: "Tune in next time to Midnight Radio." }, { kind: "music", cue: "theme" }],
  });
  const EPISODE = { bookId: "b", chapterId: "c", episodeNumber: 2, seriesTitle: "Midnight Radio", chapterTitle: "II", chapterText: CHAPTER };

  it("accepts the fallback done right: lead-in as ordinary narration, then the quote alone", () => {
    const r = reply([
      { kind: "narration", text: "From somewhere below, a voice cries out." },
      { kind: "narration", containsVerbatimQuote: true, text: "Who goes there?" },
    ]);
    expect(checkVerbatimQuotes(r, CHAPTER)).toEqual([]);
    expect(checkAdaptationReply(JSON.stringify(r), EPISODE).ok).toBe(true);
  });

  it("refuses the flag on a lead-in, and on long narration trying to escape the 35-word limit", () => {
    const longNarration = `The door opened. Within stood a tall old man. ${"I hesitated, and he went on: ".repeat(5)}`;
    const r = reply([
      { kind: "narration", containsVerbatimQuote: true, text: 'From somewhere below a voice cried out, "Who goes there?"' },
      { kind: "narration", containsVerbatimQuote: true, text: longNarration },
      { kind: "narration", text: "Ordinary narration is not checked here." },
    ]);
    const issues = checkVerbatimQuotes(r, CHAPTER);
    expect(issues.map((i) => i.path)).toEqual(["scenes[0].segments[0]", "scenes[0].segments[1]"]);
    expect(issues[0]!.message).toBe("this narration is marked as a verbatim quote but holds more than one quotation; give each quotation its own segment");
    expect(issues[1]!.message).toMatch(/not in the chapter exactly/);
    const checked = checkAdaptationReply(JSON.stringify(r), EPISODE);
    expect(checked.ok).toBe(false);
  });

  it("is applied only when the chapter text is given", () => {
    const r = reply([{ kind: "narration", containsVerbatimQuote: true, text: "Words from nowhere." }]);
    expect(checkAdaptationReply(JSON.stringify(r), { ...EPISODE, chapterText: undefined }).ok).toBe(true);
    expect(checkAdaptationReply(JSON.stringify(r), EPISODE).ok).toBe(false);
  });
});
