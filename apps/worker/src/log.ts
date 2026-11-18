export type LogFields = Record<string, string | number | boolean | null | undefined | readonly string[]>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** One JSON object per line on stdout, for the container log collector. */
export function jsonLogger(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const emit = (level: string) => (msg: string, fields: LogFields = {}) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
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
