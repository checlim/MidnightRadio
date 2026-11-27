export { BudgetExceededError, OverBudgetError } from "@midnight-radio/db";

/** The caller no longer owns the job's lease (expired or reclaimed). Its writes are fenced off. */
export class LeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`lease lost for job ${jobId}`);
    this.name = "LeaseLostError";
  }
}

/** Thrown by a handler for errors that retrying cannot fix (e.g. invalid input). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/**
 * Errors that must stop a whole job rather than be recorded against one line. Pass as
 * `renderSegments({ isFatal })`: once the lease is lost, another worker owns the job, so this one
 * must stop rendering instead of retrying or recording failures it may no longer publish.
 */
export const isFatalJobError = (err: unknown): boolean => err instanceof LeaseLostError;

/** A person cancelled the job. It is failed without retries. */
export class JobCancelledError extends Error {
  constructor(readonly jobId: string) {
    super("cancelled by a person");
    this.name = "JobCancelledError";
  }
}
