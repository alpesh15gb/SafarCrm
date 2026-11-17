import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", testMatch: "website-enquiries.spec.ts", fullyParallel: true, workers: 2, retries: 0,
  timeout: 30_000, expect: { timeout: 8_000 }, outputDir: ".artifacts/enquiry-test-results", reporter: "list",
  use: { baseURL: "http://127.0.0.1:3219", locale: "en-IN", timezoneId: "Asia/Kolkata", serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile-390", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
  ],
  webServer: { command: "node tests/browser/serve-enquiries.mjs", url: "http://127.0.0.1:3219", reuseExistingServer: false, timeout: 60_000 },
});
