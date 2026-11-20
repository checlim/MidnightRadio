import { resolve } from "node:path";
import { loadBudgetConfig } from "@midnight-radio/db";
import { z } from "zod";

/**
 * Web server settings for generation (Req 8.2, 8.5). The judge passkey is read by `loadGuardConfig` (guards.ts). Read per request through `webConfig()` so a
 * test can set the environment; parsing is cheap. Errors name the variable, never its value.
 */
export interface WebConfig {
  /** `GENERATION_ENABLED=true`. Off by default and on the live site: every generation route answers 404. */
  generationEnabled: boolean;
  /** Must match the worker's `MIDNIGHT_STUB_PROVIDERS`, so the cast editor offers the voices the worker casts from. */
  stubProviders: boolean;
  dataDir: string;
  /** `<dataDir>/broadcast`: published episodes and stations.json, served at `/broadcast/`. */
  broadcastDir: string;
  /** The repository root (voice catalogue). Default: two levels up from the web app, where Next runs. */
  repoRoot: string;
  /** Operator ceiling for any one Book's speech budget (`BOOK_TTS_CHAR_LIMIT`). */
  bookTtsCharCeiling: number;
  /** Header the hosting platform sets to the client's address (e.g. `fly-client-ip`). Never `x-forwarded-for`. Unset: every client shares one rate limit. */
  clientIpHeader: string | null;
}

const flag = z
  .string()
  .optional()
  .transform((s) => s?.trim().toLowerCase() ?? "")
  .pipe(z.enum(["", "true", "false"], { message: 'must be "true" or "false"' }))
  .transform((s) => s === "true");

const WebEnvSchema = z.object({
  GENERATION_ENABLED: flag,
  MIDNIGHT_STUB_PROVIDERS: flag,
  DATA_DIR: z.string().optional().transform((s) => s?.trim() || "/data"),
  REPO_ROOT: z.string().optional().transform((s) => s?.trim() || ""),
  CLIENT_IP_HEADER: z
    .string()
    .optional()
    .transform((s) => s?.trim().toLowerCase() || null)
    .pipe(z.string().regex(/^[a-z0-9-]{1,64}$/).refine((h) => h !== "x-forwarded-for", "must be the platform's own client-IP header, not x-forwarded-for").nullable()),
});

export function loadWebConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): WebConfig {
  const parsed = WebEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid web configuration: ${parsed.error.issues.map((i) => `${String(i.path[0])} ${i.message}`).join("; ")}`);
  const d = parsed.data;
  const repoRoot = d.REPO_ROOT ? resolve(cwd, d.REPO_ROOT) : resolve(cwd, "../..");
  return {
    generationEnabled: d.GENERATION_ENABLED,
    stubProviders: d.MIDNIGHT_STUB_PROVIDERS,
    // Relative to the repository root, as the worker and the CLI take it, so all share one database.
    dataDir: resolve(repoRoot, d.DATA_DIR),
    repoRoot,
    broadcastDir: resolve(repoRoot, d.DATA_DIR, "broadcast"),
    bookTtsCharCeiling: loadBudgetConfig(env).bookTtsCharCeiling,
    clientIpHeader: d.CLIENT_IP_HEADER,
  };
}

/** For pages that must never fail (the radio): whether to show the studio link. A malformed setting reads as off. */
export function generationShown(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return loadWebConfig(env).generationEnabled;
  } catch {
    return false;
  }
}
