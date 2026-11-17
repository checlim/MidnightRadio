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
