import { redactSecrets } from "@midnight-radio/tts";

export type LogFields = Record<string, string | number | boolean | null | undefined | readonly string[]>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** Environment variables whose values are secrets; their exact values are masked in every log line. */
export const SECRET_ENV_VARS = ["LLM_API_KEY", "LOCAL_AUDIO_TOKEN", "SFX_SERVICE_TOKEN", "UPLOAD_PASSKEY"] as const;

/** The secret values set in `env`, for `jsonLogger`. */
export const secretsFrom = (env: Record<string, string | undefined>): string[] =>
  SECRET_ENV_VARS.map((k) => env[k]?.trim() ?? "").filter((v) => v.length > 0);

const redactValue = (v: LogFields[string], secrets: readonly string[]): LogFields[string] =>
  typeof v === "string" ? redactSecrets(v, secrets) : Array.isArray(v) ? v.map((x) => redactSecrets(x, secrets)) : v;

/**
 * One JSON object per line on stdout, for the container log collector. The message and every
 * string field go through `redactSecrets` (credential patterns plus the exact `secrets` values),
 * so a key that slips into an error message never reaches the log.
 */
export function jsonLogger(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`), secrets: readonly string[] = []): Logger {
  const emit = (level: string) => (msg: string, fields: LogFields = {}) => {
    const clean: Record<string, LogFields[string]> = {};
    for (const [k, v] of Object.entries(fields)) clean[k] = redactValue(v, secrets);
    write(JSON.stringify({ time: new Date().toISOString(), level, msg: redactSecrets(msg, secrets), ...clean }));
  };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/**
 * Loggable summary of an error: name and message only, cut to 500 characters. No stack traces or
 * attached request objects, which can carry headers or keys.
 */
export function errorFields(err: unknown): LogFields {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return { error: name, message: message.length > 500 ? `${message.slice(0, 500)}…` : message };
}
