import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'
export default defineConfig({ testDir: './e2e', testMatch: 'application-access.spec.ts', workers: 1, retries: 0, timeout: 45_000,
  reporter: [['list']], outputDir: process.env.WB178_OUTPUT ?? 'test-results/application-access',
  use: { baseURL: origin, browserName: 'chromium', trace: 'off', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {} },
})
