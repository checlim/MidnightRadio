import { join } from "node:path";
import { z } from "zod";

export interface WorkerConfig {
  /** Persistent volume holding the SQLite database, the render cache and (later) exports. */
  dataDir: string;
  /** `<dataDir>/render-cache`: the speech render cache (task 5.2). */
  renderCacheDir: string;
  /** How long to wait for the current job to be released on SIGTERM before forcing exit. */
  shutdownTimeoutMs: number;
}

export const DB_FILE = "midnight-radio.db";
export const RENDER_CACHE_DIR = "render-cache";

// Fly.io's default kill timeout is 5 s and Docker's is 10 s; stay under both.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_000;

const WorkerEnvSchema = z.object({
  DATA_DIR: z
    .string()
    .optional()
    .transform((s) => s?.trim() || "/data"),
  WORKER_SHUTDOWN_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((s) => s?.trim() ?? "")
    .pipe(
      z.union([
        z.literal("").transform(() => DEFAULT_SHUTDOWN_TIMEOUT_MS),
        z.string().regex(/^\d+$/, "must be a whole number of milliseconds").transform(Number).refine((n) => n >= 100 && n <= 120_000, "must be between 100 and 120000"),
      ]),
    ),
});

/** Validate worker env vars. Errors name the variable but never echo its value. */
export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const parsed = WorkerEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const inner = i.code === "invalid_union" ? i.errors.flat().find((e) => e.code !== "invalid_value") : undefined;
      return `${String(i.path[0])} ${(inner ?? i).message}`;
    });
    throw new Error(`invalid worker configuration: ${problems.join("; ")}`);
  }
  const dataDir = parsed.data.DATA_DIR;
  return { dataDir, renderCacheDir: join(dataDir, RENDER_CACHE_DIR), shutdownTimeoutMs: parsed.data.WORKER_SHUTDOWN_TIMEOUT_MS };
}
