import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'
import { output } from './e2e/list-v2-evidence'
export default defineConfig({ testDir: './e2e', testMatch: 'list-v2-acceptance.spec.ts', workers: 1, retries: 0, timeout: 45_000,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }], ['html', { outputFolder: `${output}/playwright-report`, open: 'never' }]], outputDir: `${output}/test-results`,
  use: { baseURL: origin, browserName: 'chromium', locale: 'en-US', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure',
    extraHTTPHeaders: { Authorization: 'Bearer list-v2-admin-session' },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
})
