import { TtsError } from "./provider.js";

/**
 * Nothing that reaches a log or a stored error may carry a secret (tech.md: never log request
 * headers or keys). Rendering handles no API keys itself, but a local audio service may sit
 * behind a token, and error text from a service or library can echo whatever it was sent. All
 * error text that leaves this package goes through `redactSecrets`.
 */

const MASK = "[redacted]";
const MAX_MESSAGE_CHARS = 300;

const PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization headers
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
  /\b(?:authorization|api[_-]?key|x-api-key|access[_-]?token|auth[_-]?token|token|secret|password|passkey)\b["']?\s*[:=]\s*["']?[^\s"',;]+/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face tokens
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub tokens
];

// Long mixed-case strings with digits look like keys. Plain hex (such as a cache key) and paths do not.
const LONG_OPAQUE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g;
const looksLikeKey = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Mask anything that looks like a credential, plus every exact value in `secrets` (values under
 * 6 characters are ignored: masking them would mangle ordinary text).
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.length >= 6).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRegExp(s), "g"), MASK);
  }
  for (const p of PATTERNS) out = out.replace(p, MASK);
  out = out.replace(LONG_OPAQUE, (m) => (looksLikeKey(m) ? MASK : m));
  return out;
}

export interface ErrorSummary {
  kind: string;
  message: string;
  retryable: boolean;
}

/** A loggable, storable description of a failure: redacted, short, with no stack trace or attached objects. */
export function describeError(err: unknown, secrets: readonly string[] = []): ErrorSummary {
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactSecrets(raw.replace(/\s+/g, " ").trim(), secrets);
  const short = message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
  if (err instanceof TtsError) return { kind: err.kind, message: short, retryable: err.retryable };
  return { kind: "internal", message: short, retryable: false };
}
