/**
 * The only way the app talks to a language model (tech.md: no direct SDK calls elsewhere).
 * Responses are untrusted text: callers must parse them with a Zod schema.
 */
export interface LlmRequest {
  system: string;
  user: string;
  /** JSON Schema for structured output. */
  jsonSchema: { name: string; schema: Record<string, unknown> };
  /** Hard cap sent to the provider; budget reservations use it as the worst case. */
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | undefined;
  requestId: string | undefined;
}

export interface LlmProvider {
  /** e.g. "openai-compatible:gpt-4o-mini", recorded with results so they can be reproduced. */
  readonly id: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Provider failure. `billed: false` means the provider provably did not charge (the request was
 * rejected before processing), so the budget reservation is released; otherwise it stays counted.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly billed: boolean,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Conservative token estimate for budgeting: ~3 characters per token over-counts English text. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3);
