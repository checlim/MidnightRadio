import { defineConfig, devices } from "@playwright/test";

/** Browser tests for the player (Task 10.4). Runs the production build; `pnpm --filter @midnight-radio/web e2e`. */
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3123", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--autoplay-policy=user-gesture-required"] } } }],
  webServer: { command: "next start -p 3123", url: "http://127.0.0.1:3123", reuseExistingServer: true, env: { NEXT_TELEMETRY_DISABLED: "1" } },
});
