import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { QUOTE_PARSER_VERSION, parseQuotes } from "./quotes.js";

const texts = (src: string) => parseQuotes(src).quotes.map((q) => q.text);
const problems = (src: string) => parseQuotes(src).diagnostics.map((d) => d.problem);

describe("parseQuotes: what counts as one quotation", () => {
  it("finds curly, guillemet and straight double quotes, in order, without their marks", () => {
    const r = parseQuotes("\u201cGood evening,\u201d he said. \u00abBonsoir.\u00bb Then: \"Sit down.\"");
    expect(r).toMatchObject({ parserVersion: QUOTE_PARSER_VERSION, status: "ok", style: "double" });
    expect(r.quotes.map((q) => [q.id, q.text])).toEqual([["q1", "Good evening,"], ["q2", "Bonsoir."], ["q3", "Sit down."]]);
  });

  it("gives offsets of the whole quotation and of the quoted words", () => {
    const src = "He said \u201cHello there.\u201d and left.";
    const [q] = parseQuotes(src).quotes;
    expect(src.slice(q!.start, q!.end)).toBe("\u201cHello there.\u201d");
    expect(q!.pieces.map((p) => src.slice(p.start, p.end))).toEqual(["Hello there."]);
  });

  it("splits a quotation the text breaks, and counts repeated quotations separately", () => {
    expect(texts("\u201cWelcome,\u201d said the Count, \u201cto my house.\u201d \u201cWelcome,\u201d he said again.")).toEqual(["Welcome,", "to my house.", "Welcome,"]);
  });

  it("keeps apostrophes and contractions inside and outside quotations", () => {
    expect(texts("It\u2019s late. \u201cDon\u2019t go; \u2019tis the hour the wolves\u2019 song begins.\u201d The boys\u2019 room was dark.")).toEqual(["Don\u2019t go; \u2019tis the hour the wolves\u2019 song begins."]);
    expect(parseQuotes("It\u2019s the boys\u2019 room, isn\u2019t it?").status).toBe("ok");
  });

  it("counts nested quotations once, as part of the outer one, at any depth", () => {
    expect(texts("\u201cHe told me, \u2018Run!\u2019 and I ran.\u201d")).toEqual(["He told me, \u2018Run!\u2019 and I ran."]);
    expect(texts("\u201cShe wrote: \u2018To them I say: \u201cPouf!\u201d \u2019 And he snapped his fingers.\u201d")).toEqual(["She wrote: \u2018To them I say: \u201cPouf!\u201d \u2019 And he snapped his fingers."]);
  });

  it("joins a speech over several paragraphs, each reopened, into one quotation", () => {
    const src = "He continued:\n\n\u201cWe had been talking of horses.\n\n\u201cYou kept your eyes upon the ground.\n\n\u201cThen you smiled.\u201d\n\nI was amazed.";
    const r = parseQuotes(src);
    expect(r.status).toBe("ok");
    expect(r.quotes).toHaveLength(1);
    expect(r.quotes[0]!.pieces).toHaveLength(3);
    expect(r.quotes[0]!.text).toBe("We had been talking of horses. You kept your eyes upon the ground. Then you smiled.");
  });

  it("joins the lines of a quoted letter, each reopened after a line break", () => {
    const r = parseQuotes("\u201cMy Friend.\u2014Welcome to the Carpathians.\n\n\u201cYour friend,\n\u201cDracula.\u201d\n\n4 May.\u2014I found that my landlord had a letter.");
    expect(r.status).toBe("ok");
    expect(r.quotes.map((q) => [q.text, q.pieces.length])).toEqual([["My Friend.\u2014Welcome to the Carpathians. Your friend, Dracula.", 3]]);
  });

  it("keeps quoted verse that is not reopened, when the quotation then closes", () => {
    const r = parseQuotes("I read:\n\n\u201cAnd Ethelred spoke\u2014\n\nWho entereth herein, a conqueror hath bin;\nWho slayeth the dragon, the shield he shall win;\n\nAnd he struck the dragon.\u201d\n\nI paused.");
    expect(r.status).toBe("ok");
    expect(r.quotes[0]!.pieces).toHaveLength(4);
  });

  it("reads curly single quotes as dialogue in a chapter without double quotes", () => {
    const r = parseQuotes("\u2018Who\u2019s there?\u2019 she asked. \u2018It\u2019s only me,\u2019 said the boys\u2019 tutor.");
    expect(r).toMatchObject({ status: "ok", style: "single" });
    expect(r.quotes.map((q) => q.text)).toEqual(["Who\u2019s there?", "It\u2019s only me,"]);
  });

  it("reports a genuinely quote-free chapter as ok with no quotes", () => {
    expect(parseQuotes("It was a dark night. The wind\u2019s howl rose and fell.")).toMatchObject({ status: "ok", style: "none", quotes: [] });
    expect(parseQuotes("")).toMatchObject({ status: "ok", quotes: [] });
  });
});

describe("parseQuotes: fails closed on ambiguity", () => {
  it.each([
    ["a closing mark with nothing open", "He said Hello.\u201d", "stray_closing_mark"],
    ["an opening mark inside an open quotation, mid-line", "\u201cOne, \u201ctwo.\u201d", "opening_inside_quote"],
    ["a quotation left open at the end", "He began: \u201cOnce upon a time", "unclosed_quote"],
    ["a straight mark with spaces on both sides", 'Height 5 " wide.', "unclear_mark"],
    ["empty quote marks", "He said \u201c\u201d and stopped.", "empty_quote"],
    ["straight single-quote dialogue", "'Who goes there?' he asked. 'Me,' she said.", "straight_single_quotes"],
    ["a missing closing mark before the next speech", "\u201cCome in.\n\nShe smiled. \u201cThank you.\u201d", "opening_inside_quote"],
  ])("%s", (_label, src, problem) => {
    const r = parseQuotes(src);
    expect(r.status).toBe("ambiguous");
    expect(problems(src)).toContain(problem);
    expect(r.diagnostics[0]!.context.length).toBeGreaterThan(0);
  });

  it("closes a nested quotation at a spaced ” ’, so a double quote directly inside the outer one is still caught", () => {
    expect(parseQuotes("\u201cShe said, \u2018I cried \u201cHelp!\u201d \u2019 and then \u201cAgain!\u201d I said.\u201d").status).toBe("ambiguous");
    expect(parseQuotes("\u201cShe said, \u2018I cried \u201cHelp!\u201d \u2019 and then left.\u201d").status).toBe("ok");
  });

  it("never reports a chapter with unclear quoting as quote-free", () => {
    for (const src of ['"', "\u201d", "\u201c", "'Hi,' he said."]) expect(parseQuotes(src).status).toBe("ambiguous");
  });
});

describe("parseQuotes: properties", () => {
  const word = fc.stringMatching(/^[A-Za-z]{1,8}$/);
  const words = fc.array(word, { minLength: 1, maxLength: 8 }).map((w) => w.join(" "));

  it("recovers every quotation of generated prose exactly, in order", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(words, words), { minLength: 1, maxLength: 6 }), fc.constantFrom("curly", "straight"), (pairs, marks) => {
        const [o, c] = marks === "curly" ? ["\u201c", "\u201d"] : ['"', '"'];
        const src = pairs.map(([narration, speech]) => `${narration}. ${o}${speech}.${c}`).join(" ");
        const r = parseQuotes(src);
        expect(r.status).toBe("ok");
        expect(r.quotes.map((q) => q.text)).toEqual(pairs.map(([, speech]) => `${speech}.`));
        for (const q of r.quotes) expect(src.slice(q.pieces[0]!.start, q.pieces[q.pieces.length - 1]!.end)).toBe(q.text);
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic and never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("a", " ", "\n", "\u201c", "\u201d", "\u2018", "\u2019", '"', "'", ".") , maxLength: 60 }), (src) => {
        const a = parseQuotes(src);
        expect(parseQuotes(src)).toEqual(a);
        expect(a.status === "ok" || a.diagnostics.length > 0).toBe(true);
        for (const q of a.quotes) for (const p of q.pieces) expect(p.start <= p.end && p.end <= src.length).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
