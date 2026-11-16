import { defineConfig } from '@playwright/test'
import { artifactRoot, origin } from './e2e/runtime/workflow-setup'
export default defineConfig({
  testDir: './e2e', testMatch: 'workflow-polling.spec.ts', workers: 1, retries: 0,
  maxFailures: 1, timeout: 60_000, reporter: [['list'], ['json', { outputFile: `${artifactRoot}/results.json` }]],
  outputDir: `${artifactRoot}/playwright`,
  use: { baseURL: origin, extraHTTPHeaders: { Authorization: 'Bearer w29-owner-session' }, browserName: 'chromium', trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
})
