import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'
export default defineConfig({ testDir: './e2e', testMatch: 'row-invitations.spec.ts', workers: 1, retries: 0, timeout: 30_000,
  reporter: [['list']], outputDir: 'test-results/row-invitations', use: { baseURL: origin, viewport: { width: 1440, height: 900 }, browserName: 'chromium', trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
})
