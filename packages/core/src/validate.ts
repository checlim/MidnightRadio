import { createHash } from "node:crypto";
import { checkAdaptationRules, type AdaptationIssue, type EpisodeInfo } from "./adaptation.js";
import { nameKey } from "./cast.js";
import { NORMALISER_VERSION, normaliseForComparison } from "./normalise.js";
import type { QuoteDiagnostic, QuoteKind, QuoteParse } from "./quotes.js";
import type { Script, Segment } from "./schema.js";
import { auditScriptSfx, type SfxCatalogue } from "./sfx.js";
import { checkVerbatimQuotes, quoteBody } from "./verbatim.js";
import { isReservedName } from "./voice.js";

/**
 * The validation gate (Task 8.1, Req 4.1, 4.2, 4.4). Pure: given a parsed Script, the chapter's
 * source quotes, the Cast and the sound library, it decides whether the Script may be rendered
 * and writes the report stored with it. Only a passing report advances to rendering.
 *
 * Fidelity: the source quotes and the Script's speech (dialogue, and narration marked as a
 * verbatim quote) are aligned in order, after comparison normalisation. A source quote matches
 * one speech segment, several adjacent ones together, or is one of several consecutive quotes a
 * single segment says without the words between them. The alignment matches as many source quotes
 * as possible, each source quote and each segment at most once, ties broken deterministically.
 * Fidelity counts speech quotes only (Req 4.2, parser policy quotes-2): words quoted as terms
 * ("robber steak") are aligned too, so voicing them is fine, but leaving them out costs nothing.
 * `fidelity = matched speech / total speech`, 1 for a chapter that parsed and has none. Every speech
 * segment must be part of a match: one that is not (invented, partial or replayed) fails the
 * gate whatever the fidelity, since the 0.90 threshold tolerates missing quotes only.
 */

export const VALIDATOR_VERSION = "validate-1";
export const FIDELITY_THRESHOLD = 0.9;
/** Longest run of segments that may make up one source quote, or of quotes said in one segment. */
const MAX_JOIN = 8;

/** A source quote as the validator sees it: the whole quote, or the part of it that falls in one part of a split chapter. */
export interface QuoteUnit {
  id: string;
  kind: QuoteKind;
  text: string;
  /** For split chapters: the quote began in an earlier part / carries on into a later one. */
  continuesFromPrevious: boolean;
  continuesIntoNext: boolean;
}

/** The quotes of a whole chapter. */
export const quoteUnits = (parse: QuoteParse): QuoteUnit[] => parse.quotes.map((q) => ({ id: q.id, kind: q.kind, text: q.text, continuesFromPrevious: false, continuesIntoNext: false }));

/**
 * The quotes of one part of a split chapter (Req 1.5): each quote that overlaps
 * [partStart, partEnd) of the chapter's source text, cut to the part. Parse the whole chapter
 * first, so a quote that crosses a part boundary is not mistaken for an unbalanced one.
 */
export function quoteUnitsForPart(parse: QuoteParse, sourceText: string, partStart: number, partEnd: number): QuoteUnit[] {
  const units: QuoteUnit[] = [];
  for (const q of parse.quotes) {
    const pieces = q.pieces
      .map((p) => ({ start: Math.max(p.start, partStart), end: Math.min(p.end, partEnd) }))
      .filter((p) => p.end > p.start)
      .map((p) => sourceText.slice(p.start, p.end).trim())
      .filter((t) => t.length > 0);
    if (pieces.length === 0) continue;
    units.push({ id: q.id, kind: q.kind, text: pieces.join(" "), continuesFromPrevious: q.pieces[0]!.start < partStart, continuesIntoNext: q.pieces[q.pieces.length - 1]!.end > partEnd });
  }
  return units;
}

export interface SpeechSegment {
  path: string;
  kind: "dialogue" | "narration";
  speaker: string | null;
  /** Comparison form, quote marks at the ends removed. */
  text: string;
  original: string;
}

/** The Script's speech, in Script order. */
export function speechSegments(script: Pick<Script, "coldOpen" | "scenes" | "close">): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  const take = (seg: Segment, path: string) => {
    if (seg.kind === "dialogue") out.push({ path, kind: "dialogue", speaker: seg.speaker, text: quoteBody(seg.text), original: seg.text });
    else if (seg.kind === "narration" && seg.containsVerbatimQuote) out.push({ path, kind: "narration", speaker: null, text: quoteBody(seg.text), original: seg.text });
  };
  script.coldOpen.forEach((s, i) => take(s, `coldOpen[${i}]`));
  script.scenes.forEach((scene, si) => scene.segments.forEach((s, i) => take(s, `scenes[${si}].segments[${i}]`)));
  script.close.forEach((s, i) => take(s, `close[${i}]`));
  return out;
}

export interface Alignment {
  /** Source quote index → the speech segment indexes that say it. */
  matches: { quote: number; segments: number[] }[];
  unmatchedQuotes: number[];
  unmatchedSegments: number[];
}

/**
 * Maximum ordered, non-overlapping alignment of source quotes (normalised text) and speech
 * segments. Dynamic programming over (quotes used, segments used): maximise matched quotes, then
 * minimise unmatched segments; among equal results the first move in a fixed order wins.
 */
export function alignQuotes(quotes: readonly string[], segments: readonly string[]): Alignment {
  const n = quotes.length;
  const m = segments.length;
  type Cell = { matched: number; strays: number; move: Move } | undefined;
  type Move = { kind: "end" } | { kind: "skipQuote" } | { kind: "skipSegment" } | { kind: "match"; q: number; s: number };
  // best[i][j]: best result for quotes[i..] and segments[j..]
  const best: Cell[][] = Array.from({ length: n + 1 }, () => new Array<Cell>(m + 1));
  const better = (a: { matched: number; strays: number }, b: Cell) => !b || a.matched > b.matched || (a.matched === b.matched && a.strays < b.strays);
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) {
        best[i]![j] = { matched: 0, strays: 0, move: { kind: "end" } };
        continue;
      }
      let cell: Cell;
      const consider = (matched: number, strays: number, move: Move) => {
        if (better({ matched, strays }, cell)) cell = { matched, strays, move };
      };
      // 1. one quote said over k adjacent segments (k = 1 is a plain match)
      if (i < n) {
        let joined = "";
        for (let k = 1; k <= MAX_JOIN && j + k <= m; k++) {
          joined = k === 1 ? segments[j]! : `${joined} ${segments[j + k - 1]!}`;
          if (joined.length > quotes[i]!.length) break;
          if (joined === quotes[i]) {
            const rest = best[i + 1]![j + k]!;
            consider(rest.matched + 1, rest.strays, { kind: "match", q: 1, s: k });
          }
        }
      }
      // 2. several consecutive quotes said in one segment
      if (j < m) {
        let joined = quotes[i] ?? "";
        for (let l = 2; l <= MAX_JOIN && i + l <= n; l++) {
          joined = `${joined} ${quotes[i + l - 1]!}`;
          if (joined.length > segments[j]!.length) break;
          if (joined === segments[j]) {
            const rest = best[i + l]![j + 1]!;
            consider(rest.matched + l, rest.strays, { kind: "match", q: l, s: 1 });
          }
        }
      }
      // 3. a source quote the Script does not say
      if (i < n) {
        const rest = best[i + 1]![j]!;
        consider(rest.matched, rest.strays, { kind: "skipQuote" });
      }
      // 4. a speech segment that matches nothing
      if (j < m) {
        const rest = best[i]![j + 1]!;
        consider(rest.matched, rest.strays + 1, { kind: "skipSegment" });
      }
      best[i]![j] = cell;
    }
  }
  const out: Alignment = { matches: [], unmatchedQuotes: [], unmatchedSegments: [] };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const move = best[i]![j]!.move;
    if (move.kind === "match") {
      const segs = Array.from({ length: move.s }, (_, k) => j + k);
      for (let l = 0; l < move.q; l++) out.matches.push({ quote: i + l, segments: segs });
      i += move.q;
      j += move.s;
    } else if (move.kind === "skipQuote") out.unmatchedQuotes.push(i++);
    else if (move.kind === "skipSegment") out.unmatchedSegments.push(j++);
    else break;
  }
  return out;
}

export interface ValidationCastMember {
  name: string;
  role: "announcer" | "narrator" | "character";
  speaks: boolean;
}

export interface ValidationInput {
  script: Script;
  episode: EpisodeInfo;
  /** The chapter's `source_text`, for the source hash. */
  sourceText: string;
  /** The chapter's `canonical_text`, for the verbatim-quote fallback check. */
  canonicalText: string;
  quoteParse: QuoteParse;
  /** `quoteUnits(quoteParse)`, or `quoteUnitsForPart` for one part of a split chapter. */
  quotes: QuoteUnit[];
  cast: ValidationCastMember[];
  sfx: SfxCatalogue;
}

export type ReverseErrorKind = "duplicated" | "partial" | "invented";

export interface ValidationReport {
  validatorVersion: string;
  parserVersion: string;
  normaliserVersion: string;
  ok: boolean;
  fidelity: number | null;
  threshold: number;
  sourceSha256: string;
  scriptSha256: string;
  quoteParse: { status: QuoteParse["status"]; style: QuoteParse["style"]; diagnostics: QuoteDiagnostic[] };
  counts: { sourceQuotes: number; speechQuotes: number; matchedSpeechQuotes: number; terms: number; matchedTerms: number; speechSegments: number; unmatchedSegments: number };
  /** Speech quotes the Script does not say: they lower fidelity and are sent back to the adapter. */
  missingQuotes: { id: string; text: string }[];
  /** Terms (words quoted for emphasis or as names) the Script does not say. Reported, not scored. */
  unvoicedTerms: { id: string; text: string }[];
  /** Speech that does not match the source in order. */
  reverseErrors: { path: string; kind: ReverseErrorKind; text: string }[];
  /** Rule, speaker and sound problems, each with its path. */
  issues: AdaptationIssue[];
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function classify(segment: string, quotes: readonly string[], matchedTexts: ReadonlySet<string>): ReverseErrorKind {
  if (matchedTexts.has(segment)) return "duplicated";
  if (segment.length > 0 && quotes.some((q) => q.includes(segment))) return "partial";
  return "invented";
}

/** Run every check and build the report. `ok` only if nothing failed and fidelity reaches the threshold. */
export function validateScript(input: ValidationInput): ValidationReport {
  const { script, episode } = input;
  const issues: AdaptationIssue[] = [...checkAdaptationRules(script, episode), ...checkVerbatimQuotes(script, input.canonicalText)];

  // Speakers: every dialogue speaker is a Cast character who speaks (matched by name key).
  const byKey = new Map(input.cast.map((c) => [nameKey(c.name), c]));
  const speech = speechSegments(script);
  for (const s of speech) {
    if (s.kind !== "dialogue") continue;
    const who = byKey.get(nameKey(s.speaker!));
    if (isReservedName(s.speaker!) || (who && who.role !== "character")) issues.push({ path: s.path, message: `"${s.speaker}" cannot speak dialogue; use announcer or narration segments for them` });
    else if (!who) issues.push({ path: s.path, message: `speaker "${s.speaker}" is not in the Cast; use a Cast name, or put the quotation in narration marked as a verbatim quote` });
    else if (!who.speaks) issues.push({ path: s.path, message: `"${who.name}" never speaks in the Cast, so has no voice; put the quotation in narration marked as a verbatim quote` });
  }

  // Sounds: the same audit the MCP server runs.
  for (const sfx of auditScriptSfx(input.sfx, script)) issues.push({ path: sfx.path, message: sfx.message });

  // Fidelity and the reverse check. An ambiguous parse fails closed: no fidelity is computed.
  const parsed = input.quoteParse.status === "ok";
  const quoteTexts = input.quotes.map((q) => normaliseForComparison(q.text));
  const align = alignQuotes(quoteTexts, speech.map((s) => s.text));
  const matchedTexts = new Set(align.matches.map((mt) => quoteTexts[mt.quote]!));
  const reverseErrors = align.unmatchedSegments.map((j) => ({ path: speech[j]!.path, kind: classify(speech[j]!.text, quoteTexts, matchedTexts), text: speech[j]!.original }));
  const isSpeech = (i: number) => input.quotes[i]!.kind === "speech";
  const total = input.quotes.filter((q) => q.kind === "speech").length;
  const matched = align.matches.filter((mt) => isSpeech(mt.quote)).length;
  const terms = input.quotes.length - total;
  const matchedTerms = align.matches.length - matched;
  const fidelity = !parsed ? null : total === 0 ? 1 : matched / total;
  if (!parsed) issues.push({ path: "(source)", message: `the chapter's quotations could not be read with confidence (${input.quoteParse.diagnostics.length} problem(s)); it needs manual review` });

  const ok = parsed && issues.length === 0 && reverseErrors.length === 0 && fidelity !== null && fidelity >= FIDELITY_THRESHOLD;
  return {
    validatorVersion: VALIDATOR_VERSION,
    parserVersion: input.quoteParse.parserVersion,
    normaliserVersion: NORMALISER_VERSION,
    ok,
    fidelity,
    threshold: FIDELITY_THRESHOLD,
    sourceSha256: sha256(input.sourceText),
    scriptSha256: sha256(JSON.stringify(script)),
    quoteParse: { status: input.quoteParse.status, style: input.quoteParse.style, diagnostics: input.quoteParse.diagnostics },
    counts: { sourceQuotes: input.quotes.length, speechQuotes: total, matchedSpeechQuotes: matched, terms, matchedTerms, speechSegments: speech.length, unmatchedSegments: reverseErrors.length },
    missingQuotes: align.unmatchedQuotes.filter(isSpeech).map((i) => ({ id: input.quotes[i]!.id, text: input.quotes[i]!.text })),
    unvoicedTerms: align.unmatchedQuotes.filter((i) => !isSpeech(i)).map((i) => ({ id: input.quotes[i]!.id, text: input.quotes[i]!.text })),
    reverseErrors,
    issues,
  };
}

/** Problems to send back to the adapter for a repair attempt (Task 8.2): rules, reverse-check errors and missing quotations. */
export function repairFeedback(report: ValidationReport, maxMissing = 15): AdaptationIssue[] {
  const reverse = report.reverseErrors.map((e): AdaptationIssue => ({
    path: e.path,
    message:
      e.kind === "duplicated"
        ? "this line repeats a quotation already used; each quotation is said once"
        : e.kind === "partial"
          ? "this line is only part of a quotation; say the whole quotation, word for word"
          : "this line is not a quotation from the chapter; dialogue must be copied word for word, never invented or reworded",
  }));
  const missing = report.missingQuotes.slice(0, maxMissing).map((q): AdaptationIssue => ({ path: `(missing ${q.id})`, message: `this quotation from the chapter is missing, include it word for word: "${q.text}"` }));
  const more = report.missingQuotes.length > maxMissing ? [{ path: "(missing)", message: `and ${report.missingQuotes.length - maxMissing} more quotations are missing` }] : [];
  return [...report.issues, ...reverse, ...missing, ...more];
}

