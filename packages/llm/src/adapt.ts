import { setTimeout as sleep } from "node:timers/promises";
import { AdaptedScriptSchema, checkAdaptationReply, type AdaptationIssue, type Script } from "@midnight-radio/core";
import { BudgetExceededError, type BudgetLedger } from "@midnight-radio/db";
import { SERIES_TITLE, buildAdaptationPrompt, type AdaptationInput } from "./adapt-prompt.js";
import { providerSchema } from "./casting.js";
import { LlmError, estimateTokens, type LlmProvider, type LlmRequest, type LlmResponse } from "./provider.js";

/**
 * One adaptation attempt for one chapter (Task 7.2, Req 3.1): build the prompt, make one
 * structured-output request reserved against the budget and fenced by the job lease, and check
 * the reply. The repair loop (Task 8.2) calls this again with the problems found, at most twice.
 * Transient provider errors (rate limits, timeouts) are retried here; they are not the model's fault.
 */

const SCHEMA = { name: "radio_script", schema: providerSchema(AdaptedScriptSchema) };

/** Output allowance: the dialogue is copied verbatim and the narration is shorter than the prose, so the reply is roughly the chapter's size. */
export function adaptationOutputTokens(chapterText: string): number {
  return Math.min(32_000, Math.max(4_000, Math.ceil(estimateTokens(chapterText) * 1.2) + 2_000));
}

export interface AdaptOptions {
  provider: LlmProvider;
  ledger: Pick<BudgetLedger, "withReservation">;
  input: AdaptationInput;
  bookId: string;
  chapterId: string;
  jobId?: string;
  /** Problems with the previous attempt, from this check or the validator (Task 8.2). Sent back to the model. */
  feedback?: readonly AdaptationIssue[];
  /** Job-lease check, run inside the budget reservation (pass the job context's `assertLease`). */
  fence?: () => void;
  signal?: AbortSignal;
  /** Tries for transient provider errors. Default 3. */
  maxTransientAttempts?: number;
  delay?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

export type AdaptResult =
  | { ok: true; script: Script; providerId: string; requestId: string | undefined }
  /** The model replied, but the reply broke a rule. `issues` can be passed back as `feedback`. */
  | { ok: false; issues: AdaptationIssue[]; providerId: string; requestId: string | undefined };

/** At most this many problems are sent back, so feedback cannot crowd out the chapter. */
const MAX_FEEDBACK_ISSUES = 20;

export function feedbackText(issues: readonly AdaptationIssue[]): string {
  const shown = issues.slice(0, MAX_FEEDBACK_ISSUES);
  const more = issues.length > shown.length ? `\n(and ${issues.length - shown.length} more of the same kinds)` : "";
  return `Your previous script was not accepted. Fix these problems and reply with the whole script again, as JSON only:\n${shown.map((i) => `- ${i.path}: ${i.message}`).join("\n")}${more}`;
}

export async function adaptChapter(opts: AdaptOptions): Promise<AdaptResult> {
  const prompt = buildAdaptationPrompt(opts.input);
  const maxOutputTokens = adaptationOutputTokens(opts.input.chapter.canonicalText);
  const request: LlmRequest = {
    system: prompt.system,
    user: opts.feedback && opts.feedback.length > 0 ? `${prompt.user}\n\n${feedbackText(opts.feedback)}` : prompt.user,
    jsonSchema: SCHEMA,
    maxOutputTokens,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const maxAttempts = opts.maxTransientAttempts ?? 3;
  const delay = opts.delay ?? ((ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }));

  let response: LlmResponse;
  for (let attempt = 1; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      response = await opts.ledger.withReservation(
        {
          bookId: opts.bookId,
          chapterId: opts.chapterId,
          jobId: opts.jobId ?? null,
          llmInputTokens: estimateTokens(request.system + request.user),
          llmMaxOutputTokens: maxOutputTokens,
        },
        async () => {
          const r = await opts.provider.complete(request);
          return {
            value: r,
            usage: {
              ...(r.usage ? { llmInputTokens: r.usage.inputTokens, llmOutputTokens: r.usage.outputTokens } : {}),
              ...(r.requestId ? { providerRequestId: r.requestId } : {}),
            },
          };
        },
        opts.fence ? { fence: opts.fence } : {},
      );
      break;
    } catch (err) {
      if (err instanceof BudgetExceededError || !(err instanceof LlmError) || !err.retryable || attempt >= maxAttempts) throw err;
      await delay(1_000 * 2 ** (attempt - 1), opts.signal);
    }
  }

  const checked = checkAdaptationReply(response.text, {
    bookId: opts.bookId,
    chapterId: opts.chapterId,
    episodeNumber: opts.input.episodeNumber,
    seriesTitle: SERIES_TITLE,
    chapterTitle: opts.input.chapter.title,
  });
  const meta = { providerId: opts.provider.id, requestId: response.requestId };
  return checked.ok ? { ok: true, script: checked.script, ...meta } : { ok: false, issues: checked.issues, ...meta };
}
