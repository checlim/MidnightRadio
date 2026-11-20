import type { AdaptationIssue } from "./adaptation.js";
import { normaliseForComparison } from "./normalise.js";
import type { Script, Segment } from "./schema.js";

/**
 * The uncertain-speaker fallback (Task 7.3, Req 3.6). When the adapter cannot tell who says a
 * quotation, it puts the quoted words alone in a narration segment marked
 * `containsVerbatimQuote: true`; any lead-in from the text goes in a separate ordinary narration
 * segment. That flag exempts the segment from the 35-word limit, so it must not be usable on
 * anything else. A flagged segment is accepted only if, in the comparison form of the chapter text:
 *
 * - its words (ignoring quote marks at its two ends) occur exactly;
 * - at one such occurrence, the nearest character before it is an opening quote mark, and the
 *   nearest after it is a closing mark, the reopening mark of the quotation's next paragraph, or
 *   the end of the chapter (so it is a whole quotation, or a whole piece of one where the text
 *   itself breaks it, and no lead-in is attached);
 * - no quote mark is left inside it (so it is one quotation, not several run together).
 *
 * Quote marks here are double quotes and guillemets (folded to `"`). Single-quote dialogue folds
 * to the same character as an apostrophe, so it cannot be told apart here; the quote parser of
 * Task 8.1 handles it. Which quotations are attributed to whom is also checked there.
 */

const QUOTE = '"';

/** Comparison form of a flagged segment's text, without the quote marks and spaces at its ends. */
export const quoteBody = (text: string): string => normaliseForComparison(text).replace(/^[\s"]+|[\s"]+$/g, "");

/** Index of the nearest non-space character before `i`, or -1. */
const prevNonSpace = (s: string, i: number) => {
  let j = i - 1;
  while (j >= 0 && s[j] === " ") j--;
  return j;
};
/** Index of the nearest non-space character at or after `i`, or `s.length`. */
const nextNonSpace = (s: string, i: number) => {
  let j = i;
  while (j < s.length && s[j] === " ") j++;
  return j;
};

/**
 * Folding makes opening and closing marks the same `"`, so they are told apart by their
 * neighbours, as for straight quotes: an opening mark follows the start, a space, or an opening
 * bracket or dash, and is followed by a non-space; a closing mark follows a non-space and is
 * followed by the end, a space or punctuation.
 */
export const isOpeningQuote = (s: string, i: number): boolean =>
  s[i] === QUOTE && (i === 0 || /[\s(\[-]/.test(s[i - 1]!)) && i + 1 < s.length && s[i + 1] !== " ";
export const isClosingQuote = (s: string, i: number): boolean =>
  s[i] === QUOTE && i > 0 && s[i - 1] !== " " && (i + 1 === s.length || /[\s.,;:!?)\]-]/.test(s[i + 1]!));

export type VerbatimProblem = "empty" | "not_in_text" | "several_quotes" | "not_a_quotation";

/** Why a flagged segment's text is not a single verbatim quotation from the chapter, or null if it is. */
export function verbatimQuoteProblem(segmentText: string, chapterComparison: string): VerbatimProblem | null {
  const body = quoteBody(segmentText);
  if (body.length === 0) return "empty";
  if (body.includes(QUOTE)) return "several_quotes";
  let found = false;
  for (let at = chapterComparison.indexOf(body); at !== -1; at = chapterComparison.indexOf(body, at + 1)) {
    found = true;
    const before = prevNonSpace(chapterComparison, at);
    const after = nextNonSpace(chapterComparison, at + body.length);
    // Ends at a closing mark, at the reopening mark of the quotation's next paragraph, or at the end of the chapter.
    const endsQuote = after === chapterComparison.length || isClosingQuote(chapterComparison, after) || isOpeningQuote(chapterComparison, after);
    if (before >= 0 && isOpeningQuote(chapterComparison, before) && endsQuote) return null;
  }
  return found ? "not_a_quotation" : "not_in_text";
}

const MESSAGES: Record<VerbatimProblem, string> = {
  empty: "is marked as a verbatim quote but has no words",
  not_in_text: "is marked as a verbatim quote, but these words are not in the chapter exactly; copy the quotation word for word",
  several_quotes: "is marked as a verbatim quote but holds more than one quotation; give each quotation its own segment",
  not_a_quotation:
    "is marked as a verbatim quote, but in the chapter these words are not a whole quotation; put only the quoted words in it, move any lead-in to a separate ordinary narration segment, and do not mark narration as a quote",
};

/** Check every segment marked `containsVerbatimQuote` against the chapter's canonical text. */
export function checkVerbatimQuotes(script: Pick<Script, "coldOpen" | "scenes" | "close">, chapterCanonicalText: string): AdaptationIssue[] {
  const chapter = normaliseForComparison(chapterCanonicalText);
  const issues: AdaptationIssue[] = [];
  const check = (seg: Segment, path: string) => {
    if (seg.kind !== "narration" || !seg.containsVerbatimQuote) return;
    const problem = verbatimQuoteProblem(seg.text, chapter);
    if (problem) issues.push({ path, message: `this narration ${MESSAGES[problem]}` });
  };
  script.coldOpen.forEach((s, i) => check(s, `coldOpen[${i}]`));
  script.scenes.forEach((scene, si) => scene.segments.forEach((s, i) => check(s, `scenes[${si}].segments[${i}]`)));
  script.close.forEach((s, i) => check(s, `close[${i}]`));
  return issues;
}
