import { describe, expect, it, vi } from "vitest";
import { checkLlmAccess, createOpenAiCompatibleProvider, loadLlmConfig } from "./openai-compatible.js";
import { LlmError, type LlmRequest } from "./provider.js";

const KEY = "sk-test-SECRET-123";
const config = { baseUrl: "https://llm.example/v1", apiKey: KEY, model: "test-model", timeoutMs: 5_000 };
const req: LlmRequest = { system: "sys", user: "usr", jsonSchema: { name: "x", schema: { type: "object" } }, maxOutputTokens: 500 };
const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
const reply = { id: "chatcmpl-1", choices: [{ message: { content: '{"characters":[]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 8 } };

async function failure(fetchImpl: typeof fetch, request: LlmRequest = req) {
  try {
    await createOpenAiCompatibleProvider(config, fetchImpl).complete(request);
  } catch (e) {
    return e as LlmError;
  }
  throw new Error("expected failure");
}

describe("loadLlmConfig", () => {
  it("is unavailable without an API key, and requires a model with one", () => {
    expect(loadLlmConfig({})).toBeUndefined();
    expect(() => loadLlmConfig({ LLM_API_KEY: KEY })).toThrow("LLM_MODEL is required");
    expect(loadLlmConfig({ LLM_API_KEY: ` ${KEY} `, LLM_MODEL: "m", LLM_BASE_URL: "https://x.test/v1/" })).toEqual({
      baseUrl: "https://x.test/v1",
      apiKey: KEY,
      model: "m",
      timeoutMs: 90_000,
    });
  });

  it("rejects malformed values without echoing them", () => {
    expect(() => loadLlmConfig({ LLM_API_KEY: KEY, LLM_MODEL: "m", LLM_BASE_URL: "ftp://secret-host" })).toThrow(/LLM_BASE_URL is malformed/);
    expect(() => loadLlmConfig({ LLM_API_KEY: KEY, LLM_MODEL: "m", LLM_TIMEOUT_MS: "soon" })).toThrow(/LLM_TIMEOUT_MS/);
    try {
      loadLlmConfig({ LLM_API_KEY: KEY, LLM_MODEL: "m", LLM_BASE_URL: "ftp://secret-host" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-host");
    }
  });
});

describe("OpenAI-compatible provider", () => {
  it("sends a structured-output chat request and returns text, usage and request id", async () => {
    const fetchImpl = vi.fn(async () => ok(reply, { "x-request-id": "req_abc" }));
    const res = await createOpenAiCompatibleProvider(config, fetchImpl as typeof fetch).complete(req);
    expect(res).toEqual({ text: '{"characters":[]}', usage: { inputTokens: 120, outputTokens: 8 }, requestId: "req_abc" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      response_format: { type: "json_schema", json_schema: { name: "x", strict: true, schema: { type: "object" } } },
      max_tokens: 500,
      temperature: 0,
    });
  });

  it("falls back to the response id and tolerates missing usage", async () => {
    const res = await createOpenAiCompatibleProvider(config, (async () => ok({ ...reply, usage: undefined })) as typeof fetch).complete(req);
    expect(res).toMatchObject({ requestId: "chatcmpl-1", usage: undefined });
  });

  it.each([
    [400, false, false],
    [401, false, false],
    [404, false, false],
    [429, false, true],
    [500, true, true],
    [503, true, true],
  ])("maps HTTP %i to billed=%s, retryable=%s", async (status, billed, retryable) => {
    const e = await failure((async () => new Response("{}", { status })) as typeof fetch);
    expect(e).toBeInstanceOf(LlmError);
    expect(e).toMatchObject({ status, billed, retryable });
  });

  it("treats network failures and timeouts as possibly billed", async () => {
    expect(await failure((async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch)).toMatchObject({ billed: true, retryable: true });
    const slow = (async (_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const provider = createOpenAiCompatibleProvider({ ...config, timeoutMs: 1_000 }, slow);
    const started = Date.now();
    await expect(provider.complete(req)).rejects.toMatchObject({ billed: true, message: expect.stringMatching(/timed out/) });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("does not retry after the caller aborts", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const e = await failure((async (_u: string, init: RequestInit) => Promise.reject(init.signal!.reason)) as unknown as typeof fetch, { ...req, signal: ctrl.signal });
    expect(e.retryable).toBe(false);
  });

  it("rejects unreadable responses and refusals", async () => {
    expect(await failure((async () => new Response("not json", { status: 200 })) as typeof fetch)).toMatchObject({ billed: true });
    const refusal = { choices: [{ message: { content: null, refusal: "I can't help with that." } }] };
    expect(await failure((async () => ok(refusal)) as typeof fetch)).toMatchObject({ message: "LLM refused the request", retryable: false });
  });

  it("never puts the API key in an error message", async () => {
    for (const impl of [async () => new Response("{}", { status: 401 }), async () => Promise.reject(new Error(`boom ${KEY}`)), async () => new Response("x")]) {
      const e = await failure(impl as typeof fetch);
      expect(e.message).not.toContain(KEY);
    }
  });
});

describe("checkLlmAccess (no tokens spent)", () => {
  const config = { baseUrl: "https://llm.example/v1", apiKey: "sk-secret-key-123", model: "gpt-x", timeoutMs: 90_000 };
  const answer = (status: number, body?: unknown) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

  it("asks for the model list with the key, and reports whether the model is in it", async () => {
    const f = answer(200, { data: [{ id: "gpt-x" }, { id: "other" }] });
    expect(await checkLlmAccess(config, f as unknown as typeof fetch)).toEqual({ modelListed: true });
    expect(f).toHaveBeenCalledWith("https://llm.example/v1/models", expect.objectContaining({ headers: { authorization: "Bearer sk-secret-key-123" } }));
    expect(await checkLlmAccess(config, answer(200, { data: [{ id: "other" }] }) as unknown as typeof fetch)).toEqual({ modelListed: false });
  });

  it("accepts an endpoint without a model list", async () => {
    for (const r of [answer(404), answer(405), answer(200, { not: "a list" })]) expect(await checkLlmAccess(config, r as unknown as typeof fetch)).toEqual({ modelListed: null });
  });

  it("names the setting to fix, never the key", async () => {
    const messages: string[] = [];
    for (const f of [answer(401), answer(403), answer(500), vi.fn(async () => Promise.reject(new TypeError("fetch failed")))]) {
      const err = await checkLlmAccess(config, f as unknown as typeof fetch).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      messages.push((err as Error).message);
    }
    expect(messages).toEqual([
      "the LLM endpoint refused LLM_API_KEY (HTTP 401)",
      "the LLM endpoint refused LLM_API_KEY (HTTP 403)",
      "the LLM endpoint at LLM_BASE_URL failed (HTTP 500)",
      "cannot reach the LLM endpoint at LLM_BASE_URL (https://llm.example/v1)",
    ]);
    expect(messages.join(" ")).not.toContain("sk-secret");
  });
});
