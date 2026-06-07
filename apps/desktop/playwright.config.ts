import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Demo specs record marketing videos on demand; keep them out of default/CI discovery.
  testIgnore: "**/demo/**",
  timeout: 60_000,
  // Electron user-surface tests are materially more reliable when one app owns the input loop at a time.
  workers: 1,
  retries: process.env.PI_APP_TEST_MODE === "foreground" ? 1 : 0,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
