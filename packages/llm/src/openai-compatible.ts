import { z } from "zod";
import { fetchWithTimeouts } from "./long-fetch.js";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "./provider.js";

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;

const LlmEnvSchema = z.object({
  LLM_BASE_URL: z
    .string()
    .optional()
    .transform((s) => s?.trim() || "https://api.openai.com/v1")
    .pipe(z.url({ protocol: /^https?$/ })),
  LLM_API_KEY: z.string().optional().transform((s) => s?.trim() || undefined),
  LLM_MODEL: z.string().optional().transform((s) => s?.trim() || undefined),
  LLM_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((s) => s?.trim() ?? "")
    .pipe(z.union([z.literal("").transform(() => DEFAULT_TIMEOUT_MS), z.string().regex(/^\d+$/).transform(Number).refine((n) => n >= 1_000 && n <= 600_000)])),
});

/**
 * Read LLM settings from the environment. Returns undefined when no API key is set (paid LLM
 * calls are then unavailable). Errors name the variable but never echo values.
 */
export function loadLlmConfig(env: Record<string, string | undefined> = process.env): OpenAiCompatibleConfig | undefined {
  const parsed = LlmEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid LLM configuration: ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")} is malformed`);
  }
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_TIMEOUT_MS } = parsed.data;
  if (!LLM_API_KEY) return undefined;
  if (!LLM_MODEL) throw new Error("invalid LLM configuration: LLM_MODEL is required when LLM_API_KEY is set");
  return { baseUrl: LLM_BASE_URL.replace(/\/+$/, ""), apiKey: LLM_API_KEY, model: LLM_MODEL, timeoutMs: LLM_TIMEOUT_MS };
}

export interface LlmAccess {
  /** Whether the endpoint's model list names `config.model`; null when it publishes no list. */
  modelListed: boolean | null;
}

const ModelsSchema = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) });

/**
 * Check the key and endpoint without spending tokens: `GET {baseUrl}/models`. Resolves when the
 * key is accepted (or the endpoint has no model list); throws LlmError with a message naming the
 * setting to fix otherwise. Never includes the key in a message.
 */
export async function checkLlmAccess(config: OpenAiCompatibleConfig, fetchImpl: typeof fetch = fetch): Promise<LlmAccess> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(Math.min(config.timeoutMs, 15_000)) });
  } catch {
    throw new LlmError(`cannot reach the LLM endpoint at LLM_BASE_URL (${config.baseUrl})`, false, true);
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    throw new LlmError(`the LLM endpoint refused LLM_API_KEY (HTTP ${res.status})`, false, false, res.status);
  }
  if (res.status === 404 || res.status === 405) {
    await res.body?.cancel().catch(() => undefined);
    return { modelListed: null };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new LlmError(`the LLM endpoint at LLM_BASE_URL failed (HTTP ${res.status})`, false, RETRYABLE.has(res.status), res.status);
  }
  const list = ModelsSchema.safeParse(await res.json().catch(() => null));
  if (!list.success) return { modelListed: null };
  return { modelListed: list.data.data.some((m) => m.id === config.model) };
}

const ResponseSchema = z.object({
  id: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), refusal: z.string().nullable().optional() }), finish_reason: z.string().nullable().optional() })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
});

/**
 * The network error code behind a failed fetch (e.g. ECONNRESET), if it is a plain code. Only the
 * code is reported, never the error's text, which could hold the URL or request details.
 */
export function networkCause(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

const CAUSE_HINTS: Record<string, string> = {
  UND_ERR_HEADERS_TIMEOUT: "the provider took too long to start answering",
  UND_ERR_BODY_TIMEOUT: "the provider stopped sending its answer",
  UND_ERR_SOCKET: "the connection was closed mid-request",
  ECONNRESET: "the connection was reset",
  ECONNREFUSED: "nothing is listening at LLM_BASE_URL",
  ENOTFOUND: "the host in LLM_BASE_URL could not be found",
  EAI_AGAIN: "DNS lookup failed; try again",
  ETIMEDOUT: "the connection timed out",
  CERT_HAS_EXPIRED: "the provider's TLS certificate has expired",
};

/** Status codes for requests the provider rejected before doing (billable) work. */
const NOT_BILLED = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429]);
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * Chat Completions client for any OpenAI-compatible endpoint, with JSON-schema structured output.
 * Never logs; error messages never include the API key, headers or the request body.
 */
export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig, fetchImpl: typeof fetch = fetchWithTimeouts(config.timeoutMs)): LlmProvider {
  return {
    id: `openai-compatible:${config.model}`,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.user },
            ],
            response_format: { type: "json_schema", json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } },
            max_tokens: req.maxOutputTokens,
            temperature: 0,
          }),
          signal,
        });
      } catch (err) {
        // Timeout or network failure: the provider may already have done the work.
        const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
        const cause = networkCause(err);
        const message = timedOut
          ? `LLM request timed out after ${Math.round(config.timeoutMs / 1000)} s or was aborted (LLM_TIMEOUT_MS)`
          : `LLM request failed to reach the provider${cause ? ` (${cause}${CAUSE_HINTS[cause] ? `: ${CAUSE_HINTS[cause]}` : ""})` : ""}`;
        throw new LlmError(message, true, !req.signal?.aborted);
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new LlmError(`LLM provider returned HTTP ${res.status}`, !NOT_BILLED.has(res.status), RETRYABLE.has(res.status), res.status);
      }
      let parsed: z.infer<typeof ResponseSchema>;
      try {
        parsed = ResponseSchema.parse(await res.json());
      } catch {
        throw new LlmError("LLM provider returned an unreadable response", true, true, res.status);
      }
      const choice = parsed.choices[0]!;
      if (choice.message.refusal) throw new LlmError("LLM refused the request", true, false, res.status);
      return {
        text: choice.message.content ?? "",
        usage: parsed.usage ? { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens } : undefined,
        requestId: res.headers.get("x-request-id") ?? parsed.id,
      };
    },
  };
}
