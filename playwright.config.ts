import { defineConfig, devices } from "@playwright/test";
import { chromiumLaunchOptions } from "./scripts/playwright-runtime.mjs";

const baseURL =
  process.env.E2E_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://127.0.0.1:5173");
const acceptanceEvidenceDir = process.env.ACCEPTANCE_EVIDENCE_DIR;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: acceptanceEvidenceDir
    ? [
        ["list"],
        [
          "junit",
          { outputFile: `${acceptanceEvidenceDir}/playwright-junit.xml` },
        ],
        [
          "html",
          {
            outputFolder: `${acceptanceEvidenceDir}/playwright-report`,
            open: "never",
          },
        ],
      ]
    : process.env.CI
      ? "github"
      : "list",
  outputDir: acceptanceEvidenceDir
    ? `${acceptanceEvidenceDir}/playwright-artifacts`
    : "test-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    viewport: { width: 1024, height: 768 },
    ignoreHTTPSErrors: true,
    launchOptions: chromiumLaunchOptions(),
    screenshot: acceptanceEvidenceDir ? "on" : "only-on-failure",
    trace: acceptanceEvidenceDir ? "retain-on-failure" : "on-first-retry",
  },
});