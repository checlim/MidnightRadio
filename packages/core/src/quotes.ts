/**
 * Source quote extraction (Task 8.1, Req 4.2). Pure and deterministic; runs on a chapter's
 * `source_text` (never folded, so ‘ ’ “ ” and ' " are still different characters).
 *
 * Policy `quotes-1`:
 * - Paragraphs are separated by a blank line; a single newline (a `<br>`) stays inside one.
 * - The chapter's dialogue marks are double quotes if it has any (curly “ ”, guillemets « » or
 *   straight "), otherwise curly single quotes ‘ ’. Marks of the other kind inside a quotation are
 *   nested quotes and part of the outer one; they are never counted on their own.
 * - A quotation may run over several paragraphs or lines. An opening mark straight after a line
 *   break (a blank line or a `<br>`) continues the open quotation: the printing convention for
 *   long speeches and for each line of a quoted letter. A paragraph that does not reopen (quoted
 *   verse, for instance) is still part of the quotation if the next mark closes it; if instead
 *   another opening mark comes first, the closing mark is missing and the chapter fails closed.
 *   Either way it is one quote, made of one piece per paragraph or line.
 * - Straight marks are opening or closing by their neighbours. A mark that is neither, a closing
 *   mark with nothing open, an opening mark inside an open quotation, an unclosed quotation and
 *   dialogue in straight single quotes (which cannot be told from apostrophes) all make the
 *   chapter `ambiguous`: it fails closed, with a diagnostic for each problem. It is never quietly
 *   treated as having no quotes.
 * - In single-quote chapters, ’ between letters is an apostrophe ("don’t"), as is a leading ’
 *   ("’tis"); a ’ after a letter and before a space or punctuation closes an open quotation.
 * - Kind (added in quotes-2): a quotation is a `term` (words quoted for emphasis or as a name)
 *   if it is one piece of at most three words and either has no sentence or clause punctuation
 *   (. , ! ? ; : … or a dash) anywhere in it (“robber steak”, “Red Death”), or its only
 *   punctuation is one trailing comma or full stop and a word comes straight before its opening
 *   mark, so it sits inside a sentence (“called “paprika hendl,” and”, “of the “House of Usher.”).
 *   Everything else is `speech`: spoken words carry punctuation inside their marks and follow
 *   punctuation (“Yes,” I said; I said, “Jonathan Harker.”). A deterministic stand-in for "is this
 *   dialogue"; fidelity is scored on speech (Req 4.2).
 */

export const QUOTE_PARSER_VERSION = "quotes-2";

export interface QuotePiece {
  /** Offsets into `sourceText` of the quoted words, without the marks (end exclusive). */
  start: number;
  end: number;
}

export type QuoteKind = "speech" | "term";

export const TERM_MAX_WORDS = 3;
const CLAUSE_PUNCTUATION = /[.,!?;:\u2026\u2014\u2013]/;

/**
 * `term` or `speech` (see the policy above). `before` is the nearest non-space character before
 * the opening mark, if any.
 */
export function quoteKind(text: string, pieces: number, before?: string): QuoteKind {
  const t = text.replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "").trim();
  const words = t.split(/\s+/).filter((w) => w.length > 0);
  if (pieces !== 1 || words.length > TERM_MAX_WORDS) return "speech";
  if (!CLAUSE_PUNCTUATION.test(t)) return "term";
  const trailingOnly = /[,.]$/.test(t) && !CLAUSE_PUNCTUATION.test(t.slice(0, -1));
  return trailingOnly && before !== undefined && /[\p{L}\p{N}]/u.test(before) ? "term" : "speech";
}

export interface SourceQuote {
  /** `q1`, `q2`… in order of appearance. */
  id: string;
  kind: QuoteKind;
  /** From the opening mark to just after the closing mark (or the end of the last piece). */
  start: number;
  end: number;
  /** One piece per paragraph. */
  pieces: QuotePiece[];
  /** The quoted words, pieces joined by a space. */
  text: string;
}

export interface QuoteDiagnostic {
  /** Offset into `sourceText`. */
  at: number;
  problem: "stray_closing_mark" | "opening_inside_quote" | "unclosed_quote" | "unclear_mark" | "straight_single_quotes" | "empty_quote";
  message: string;
  /** About 40 characters of text around the problem, for manual review. */
  context: string;
}

export interface QuoteParse {
  parserVersion: string;
  /** `ok`: every quotation found with confidence (possibly none). `ambiguous`: see diagnostics; fails validation. */
  status: "ok" | "ambiguous";
  style: "double" | "single" | "none";
  quotes: SourceQuote[];
  diagnostics: QuoteDiagnostic[];
}

const DOUBLE_OPEN = new Set(["\u201c", "\u00ab"]); // “ «
const DOUBLE_CLOSE = new Set(["\u201d", "\u00bb"]); // ” »
const STRAIGHT_DOUBLE = '"';
const SINGLE_OPEN = "\u2018"; // ‘
const SINGLE_CLOSE = "\u2019"; // ’

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const OPENERS_BEFORE = /[\s([{\u2014\u2013-]/; // a quote opens after space, a bracket or a dash

/** The nearest non-space character before `at`, or undefined at the start. */
function charBefore(text: string, at: number): string | undefined {
  let j = at - 1;
  while (j >= 0 && /\s/.test(text[j]!)) j--;
  return j >= 0 ? text[j] : undefined;
}

function context(text: string, at: number): string {
  return text.slice(Math.max(0, at - 20), at + 20).replace(/\s+/g, " ");
}

type Level = "double" | "single";
type Mark = { at: number; kind: "open" | "close"; level: Level } | { at: number; kind: "unclear"; level: Level };

/** Curly single marks: ‘ opens; ’ closes where it ends a quotation, never inside or before a word. Undefined if neither. */
function singleMark(text: string, i: number): "open" | "close" | undefined {
  const c = text[i];
  const prev = text[i - 1];
  const next = text[i + 1];
  if (c === SINGLE_OPEN) return "open";
  if (c !== SINGLE_CLOSE) return undefined;
  // ’ closes only after a non-space and before a space or punctuation, so apostrophes inside a
  // word (don’t) or leading one (’tis) are never marks.
  const endsHere = isSpace(next) || /[.,;:!?)\]}\u2014\u2013\u201d\u00bb"-]/.test(next!);
  if (!isSpace(prev) && endsHere) return "close";
  // Adjacent marks are often printed with a space between them: “Pouf!” ’ closes both.
  let j = i - 1;
  while (j >= 0 && (text[j] === " " || text[j] === "\u2009" || text[j] === "\u200a")) j--;
  if (j < i - 1 && j >= 0 && /[\u201d\u00bb"]/.test(text[j]!) && endsHere) return "close";
  return undefined;
}

/**
 * Classify the chapter's quote marks, in order. In a double-quote chapter, curly single marks are
 * classified too (level "single"), for quotations nested inside the dialogue.
 */
function marksOf(text: string, style: Level): Mark[] {
  const marks: Mark[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const prev = text[i - 1];
    const next = text[i + 1];
    if (style === "double") {
      if (DOUBLE_OPEN.has(c)) marks.push({ at: i, kind: "open", level: "double" });
      else if (DOUBLE_CLOSE.has(c)) marks.push({ at: i, kind: "close", level: "double" });
      else if (c === STRAIGHT_DOUBLE) {
        const opens = (prev === undefined || OPENERS_BEFORE.test(prev)) && !isSpace(next);
        const closes = prev !== undefined && !isSpace(prev) && (isSpace(next) || /[.,;:!?)\]}\u2014\u2013-]/.test(next!));
        marks.push(opens && !closes ? { at: i, kind: "open", level: "double" } : closes && !opens ? { at: i, kind: "close", level: "double" } : { at: i, kind: "unclear", level: "double" });
      } else {
        const k = singleMark(text, i);
        if (k) marks.push({ at: i, kind: k, level: "single" });
      }
    } else {
      const k = singleMark(text, i);
      if (k) marks.push({ at: i, kind: k, level: "single" });
    }
  }
  return marks;
}

/** True if the text has straight single quotes used like dialogue: `'Word` after a space and `word,' ` before one. */
function looksLikeStraightSingleDialogue(text: string): boolean {
  return /(^|[\s(])'[\p{L}]/u.test(text) && /[\p{L}.,!?;:]'(\s|$)/u.test(text);
}

export function parseQuotes(sourceText: string): QuoteParse {
  const hasDouble = /[\u201c\u201d\u00ab\u00bb"]/.test(sourceText);
  const hasCurlySingle = sourceText.includes(SINGLE_OPEN);
  const style: QuoteParse["style"] = hasDouble ? "double" : hasCurlySingle ? "single" : "none";
  const diagnostics: QuoteDiagnostic[] = [];
  const diag = (at: number, problem: QuoteDiagnostic["problem"], message: string) => diagnostics.push({ at, problem, message, context: context(sourceText, at) });

  if (style === "none") {
    if (looksLikeStraightSingleDialogue(sourceText)) {
      const at = sourceText.search(/(^|[\s(])'[\p{L}]/u);
      diag(Math.max(0, at), "straight_single_quotes", "the chapter seems to use straight single quotes for dialogue, which cannot be told apart from apostrophes");
      return { parserVersion: QUOTE_PARSER_VERSION, status: "ambiguous", style, quotes: [], diagnostics };
    }
    return { parserVersion: QUOTE_PARSER_VERSION, status: "ok", style, quotes: [], diagnostics };
  }

  const quotes: SourceQuote[] = [];
  type Open = { start: number; pieces: QuotePiece[]; pieceStart: number; /** Open quotations nested inside, innermost last. */ inner: Level[] };
  let open: Open | null = null;

  /** Pieces of [from, to): split at every line break, blank lines and spaces trimmed off each piece. */
  const piecesOf = (from: number, to: number): QuotePiece[] => {
    const out: QuotePiece[] = [];
    let at = from;
    for (const line of sourceText.slice(from, to).split("\n")) {
      const lead = line.length - line.trimStart().length;
      const body = line.trim();
      if (body.length > 0) out.push({ start: at + lead, end: at + lead + body.length });
      at += line.length + 1;
    }
    return out;
  };

  const finish = (closeAt: number | null) => {
    const q = open!;
    const pieces = [...q.pieces, ...piecesOf(q.pieceStart, closeAt ?? sourceText.length)];
    const text = pieces.map((p) => sourceText.slice(p.start, p.end)).join(" ");
    if (text.trim().length === 0) diag(q.start, "empty_quote", "a pair of quote marks has nothing between them");
    else quotes.push({ id: `q${quotes.length + 1}`, kind: quoteKind(text, pieces.length, charBefore(sourceText, q.start)), start: q.start, end: closeAt === null ? sourceText.length : closeAt + 1, pieces, text });
    open = null;
  };

  /** True if only spaces or tabs lie between the last line break and `at`, i.e. the mark starts a line. */
  const startsLine = (at: number) => {
    let j = at - 1;
    while (j >= 0 && (sourceText[j] === " " || sourceText[j] === "\t")) j--;
    return j >= 0 && sourceText[j] === "\n";
  };

  for (const mark of marksOf(sourceText, style)) {
    // Marks of the other level nest inside the open quotation (“… ‘… “…” …’ …”). They are part of
    // it and never counted on their own; only the outermost quotation is a source quote.
    const outer: Level = style === "single" ? "single" : "double";
    if (mark.kind !== "unclear" && mark.level !== outer) {
      if (open) {
        const o: Open = open;
        if (mark.kind === "open") o.inner.push(mark.level);
        else if (o.inner[o.inner.length - 1] === mark.level) o.inner.pop();
        // else: a closing-looking mark with nothing nested open, e.g. a plural possessive
      }
      continue; // outside dialogue these are apostrophes or scare quotes
    }
    // An outer opening mark at the start of a line continues the quotation (checked below), even if a
    // nested quotation was open: each paragraph of a nested story reopens with “ ‘.
    const reopens = mark.kind === "open" && startsLine(mark.at);
    if (open && mark.kind !== "unclear" && open.inner.length > 0 && !reopens) {
      const o: Open = open;
      if (mark.kind === "open") {
        o.inner.push(mark.level); // third level: a quotation inside a nested one
        continue;
      }
      if (o.inner[o.inner.length - 1] === mark.level) {
        o.inner.pop();
        continue;
      }
      o.inner.length = 0; // a nested quotation left unclosed ends with the outer one
    }
    if (mark.kind === "unclear") {
      diag(mark.at, "unclear_mark", "a straight quote mark that is neither clearly opening nor clearly closing");
      continue;
    }
    if (mark.kind === "close") {
      if (!open) {
        // In single-quote chapters a lone ’ after a word is a plural possessive ("the boys’ room").
        if (style === "double") diag(mark.at, "stray_closing_mark", "a closing quote mark with no open quotation");
        continue;
      }
      finish(mark.at);
      continue;
    }
    // opening mark
    if (open) {
      if (startsLine(mark.at)) {
        // Continuation: a new paragraph or line of the same quotation.
        const o: Open = open;
        o.pieces.push(...piecesOf(o.pieceStart, mark.at));
        o.pieceStart = mark.at + 1;
        o.inner.length = 0; // nested quotations reopen with their own marks if they continue
        continue;
      }
      diag(mark.at, "opening_inside_quote", "an opening quote mark inside a quotation that is still open");
      open = null;
      continue;
    }
    open = { start: mark.at, pieces: [], pieceStart: mark.at + 1, inner: [] };
  }
  if (open) diag((open as { start: number }).start, "unclosed_quote", "a quotation is still open at the end of the chapter");

  return { parserVersion: QUOTE_PARSER_VERSION, status: diagnostics.length > 0 ? "ambiguous" : "ok", style, quotes, diagnostics };
}
