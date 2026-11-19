import type { LlmProvider, LlmRequest, LlmResponse } from "./provider.js";

/**
 * Offline provider for tests and CI: never calls a paid API. `respond` returns the reply text
 * (or throws) for each request; usage is estimated from the text lengths.
 */
export class StubLlmProvider implements LlmProvider {
  readonly id = "stub";
  readonly requests: LlmRequest[] = [];

  constructor(private readonly respond: (req: LlmRequest, call: number) => string | Promise<string>) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const text = await this.respond(req, this.requests.length);
    return {
      text,
      usage: { inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4) },
      requestId: `stub-${this.requests.length}`,
    };
  }
}
