import { join } from "node:path";

/** Where the browser tests keep their data (git-ignored, reset by global-setup). */
export const FIXTURES = join(import.meta.dirname, ".fixtures");
export const DEMO_DATA = join(FIXTURES, "demo-data");
export const STUDIO_DATA = join(FIXTURES, "studio-data");

/** The studio server and its worker share these settings, so they share one database. */
export const STUDIO_ENV: Record<string, string> = {
  GENERATION_ENABLED: "true",
  MIDNIGHT_STUB_PROVIDERS: "true",
  DATA_DIR: STUDIO_DATA,
  UPLOAD_PASSKEY: "",
  GLOBAL_DAILY_TTS_CHAR_LIMIT: "1000000",
  GLOBAL_DAILY_LLM_TOKEN_LIMIT: "10000000",
  BOOK_TTS_CHAR_LIMIT: "60000",
};
