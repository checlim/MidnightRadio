import { Agent, fetch as undiciFetch } from "undici";

/**
 * `fetch` for calls that may take minutes (a slow model). Node's built-in `fetch` drops a request
 * that has had no response headers for 300 s (UND_ERR_HEADERS_TIMEOUT), whatever the request's
 * own AbortSignal allows, so a long call failed as "could not reach the provider". This one lets
 * the connection wait as long as the caller's timeout (plus a margin); the caller's AbortSignal
 * still decides when to give up.
 */
export function fetchWithTimeouts(timeoutMs: number): typeof fetch {
  const wait = timeoutMs + 10_000;
  const dispatcher = new Agent({ headersTimeout: wait, bodyTimeout: wait });
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}
