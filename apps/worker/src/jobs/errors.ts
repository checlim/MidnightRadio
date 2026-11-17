/** The caller no longer owns the job's lease (expired or reclaimed). Its writes are fenced off. */
export class LeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`lease lost for job ${jobId}`);
    this.name = "LeaseLostError";
  }
}

/** Thrown by a handler when a budget cap would be exceeded; the job is parked as `over_budget`. */
export class OverBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverBudgetError";
  }
}

/** Thrown by a handler for errors that retrying cannot fix (e.g. invalid input). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
