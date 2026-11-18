/**
 * Versioned text normalisers shared by ingestion (source) and validation (Script), Req 1.4.
 *
 * Two levels, both lossless for words, letter case and punctuation:
 * - `canonicaliseText`: what adaptation and splitting work on. Keeps paragraph and line breaks
 *   and real typography (curly quotes, em dashes) so speech stays natural.
 * - `normaliseForComparison`: canonical text with typography folded and all whitespace collapsed,
 *   used only to compare source quotes with Script lines.
 *
 * Quote extraction must run on the unfolded source text: folding ’ to ' erases the difference
 * between a closing single quote and an apostrophe.
 *
 * Bump NORMALISER_VERSION whenever either function's output can change; stored reports record it.
 */
export const NORMALISER_VERSION = "norm-1";

// Soft hyphen, zero-width space/joiners, word joiner, BOM: invisible, never words or punctuation.
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
// Horizontal whitespace, including NBSP and the Unicode space separators, but not line breaks.
const HORIZONTAL_SPACE = /[^\S\n]+/g;

const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033\u301D\u301E]/g; // “ ” „ ‟ « » ″ 〝 〞
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u2039\u203A]/g; // ‘ ’ ‚ ‛ ′ ‹ ›
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g; // ‐ ‑ ‒ – — ― − and small/full-width forms
const ELLIPSIS = /\u2026/g; // …

/**
 * Canonical source/Script text: invisible characters removed, Unicode NFC, runs of horizontal
 * whitespace folded to one space, spaces trimmed around line breaks, at most one blank line
 * between paragraphs, edges trimmed. Paragraph (`\n\n`) and line (`\n`) structure is kept.
 */
export function canonicaliseText(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .normalize("NFC")
    .replace(/\r\n?|[\u2028\u2029\u0085\u000B\u000C]/g, "\n")
    .replace(HORIZONTAL_SPACE, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "")
    .replace(/^ | $/g, "");
}

/**
 * Comparison form: canonical text with curly quotes folded to straight, dash variants to `-`,
 * `…` to `...`, and all whitespace (including line breaks) collapsed to single spaces.
 * Never lower-cases, never drops words or punctuation.
 */
export function normaliseForComparison(text: string): string {
  return canonicaliseText(text)
    .replace(DOUBLE_QUOTES, '"')
    .replace(SINGLE_QUOTES, "'")
    .replace(DASHES, "-")
    .replace(ELLIPSIS, "...")
    .replace(/\s+/g, " ")
    .trim();
}
