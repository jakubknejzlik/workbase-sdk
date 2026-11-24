import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'
const output = process.env.WIDGET_OUTPUT
if (!output) throw new Error('Set WIDGET_OUTPUT to an evidence directory')
export default defineConfig({ testDir: './e2e', testMatch: 'widget-isolation.spec.ts', workers: 1, retries: 0, timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }]], outputDir: `${output}/test-results`,
  use: { baseURL: origin, browserName: 'chromium', locale: 'en-US', trace: 'retain-on-failure',
    extraHTTPHeaders: { Authorization: 'Bearer synthetic-viewer-a' },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
})
