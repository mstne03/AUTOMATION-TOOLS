import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  snapshotPathTemplate: "{testDir}/__capturas__/{arg}{ext}",
  fullyParallel: false,
  workers: 1, // el sidecar admite un turno de chat a la vez y comparte estado
  reporter: "list",
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1200, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
