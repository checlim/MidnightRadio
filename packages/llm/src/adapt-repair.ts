import { SERIES_TITLE } from "./adapt-prompt.js";
import { adaptChapter, type AdaptOptions } from "./adapt.js";
import { repairFeedback, validateScript, type AdaptationIssue, type Script, type ValidationInput, type ValidationReport } from "@midnight-radio/core";

/**
 * Adapt, validate and repair (Task 8.2, Req 4.3): one attempt plus at most two repairs. Each
 * repair sends the previous attempt's problems back to the model: the reply's rule problems, or
 * the validation report's issues, reverse-check errors and missing quotations. The first Script
 * that passes the gate is the result; if none does, the chapter fails closed and is not rendered.
 * A chapter whose source quotations could not be read is failed before any model call: no Script
 * could pass, and it needs a person to look at it.
 */

export const MAX_REPAIRS = 2;

export interface AttemptRecord {
  /** 1 is the first attempt; 2 and 3 are repairs. */
  attempt: number;
  /** Null when the reply was not a usable Script (not JSON, wrong shape, or broke a rule before validation). */
  script: Script | null;
  /** The gate's report, when there was a Script to validate. */
  report: ValidationReport | null;
  /** What was wrong (empty for the passing attempt). */
  issues: AdaptationIssue[];
  requestId: string | undefined;
}

export type AdaptationOutcome =
  | { status: "valid"; script: Script; report: ValidationReport; attempts: AttemptRecord[]; providerId: string }
  | { status: "failed"; reason: "unreadable_quotes" | "attempts_exhausted"; message: string; attempts: AttemptRecord[]; providerId: string };

export interface AdaptWithRepairOptions extends Omit<AdaptOptions, "feedback"> {
  /** Everything the gate needs except the Script and the episode, which come from the attempt. */
  validation: Omit<ValidationInput, "script" | "episode">;
  /** Repairs after the first attempt. Default and maximum 2 (Req 4.3). */
  maxRepairs?: number;
}

export async function adaptWithRepair(opts: AdaptWithRepairOptions): Promise<AdaptationOutcome> {
  const maxRepairs = Math.min(MAX_REPAIRS, Math.max(0, opts.maxRepairs ?? MAX_REPAIRS));
  const attempts: AttemptRecord[] = [];
  if (opts.validation.quoteParse.status !== "ok") {
    return {
      status: "failed",
      reason: "unreadable_quotes",
      message: `The chapter's quotations could not be read with confidence (${opts.validation.quoteParse.diagnostics.length} problem(s)), so it needs manual review before it can be adapted.`,
      attempts,
      providerId: opts.provider.id,
    };
  }
  const episode = {
    bookId: opts.bookId,
    chapterId: opts.chapterId,
    episodeNumber: opts.input.episodeNumber,
    seriesTitle: SERIES_TITLE,
    chapterTitle: opts.input.chapter.title,
    chapterText: opts.input.chapter.canonicalText,
  };
  let feedback: AdaptationIssue[] = [];
  for (let attempt = 1; attempt <= 1 + maxRepairs; attempt++) {
    const { validation: _v, maxRepairs: _m, ...adaptOpts } = opts;
    const r = await adaptChapter({ ...adaptOpts, ...(feedback.length > 0 ? { feedback } : {}) });
    if (!r.ok) {
      attempts.push({ attempt, script: null, report: null, issues: r.issues, requestId: r.requestId });
      feedback = r.issues;
      continue;
    }
    const report = validateScript({ ...opts.validation, script: r.script, episode });
    if (report.ok) {
      attempts.push({ attempt, script: r.script, report, issues: [], requestId: r.requestId });
      return { status: "valid", script: r.script, report, attempts, providerId: opts.provider.id };
    }
    feedback = repairFeedback(report);
    attempts.push({ attempt, script: r.script, report, issues: feedback, requestId: r.requestId });
  }
  return {
    status: "failed",
    reason: "attempts_exhausted",
    message: `No adaptation passed validation after ${attempts.length} attempt(s); the chapter will not be rendered.`,
    attempts,
    providerId: opts.provider.id,
  };
}
