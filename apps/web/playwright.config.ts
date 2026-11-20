import { defineConfig, devices } from "@playwright/test";

import { DEMO_DATA, STUDIO_ENV } from "./e2e/paths";

/** Browser tests for the player (Task 10.4) and the studio (Task 11.4). Runs the production build; `pnpm --filter @midnight-radio/web e2e`. */
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3123", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--autoplay-policy=user-gesture-required"] } } }],
  webServer: [
    // The radio as the live site runs it: generation off, whatever the local .env says.
    { command: "next start -p 3123", url: "http://127.0.0.1:3123", reuseExistingServer: false, env: { NEXT_TELEMETRY_DISABLED: "1", GENERATION_ENABLED: "false", DATA_DIR: DEMO_DATA, UPLOAD_PASSKEY: "" } },
    // The studio with the offline stand-in model and tone voices; studio.spec.ts runs the worker beside it.
    { command: "next start -p 3124", url: "http://127.0.0.1:3124", reuseExistingServer: false, env: { NEXT_TELEMETRY_DISABLED: "1", ...STUDIO_ENV } },
  ],
});
