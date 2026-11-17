/** A budget cap would be exceeded. The job runner parks the job as `over_budget`. */
export class OverBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverBudgetError";
  }
}

export type BudgetLimit = "tts_disabled" | "llm_disabled" | "daily_tts" | "daily_llm" | "book_tts";

export class BudgetExceededError extends OverBudgetError {
  constructor(
    readonly limit: BudgetLimit,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}
