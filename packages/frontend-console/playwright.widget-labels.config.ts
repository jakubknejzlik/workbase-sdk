import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'

export default defineConfig({
  testDir: './e2e', testMatch: ['widget-labels.spec.ts', 'widget-labels-compat.spec.ts'], workers: 1, retries: 0, timeout: 45_000,
  reporter: [['list']], outputDir: process.env.WIDGET_LABELS_OUTPUT ? `${process.env.WIDGET_LABELS_OUTPUT}/test-results` : 'test-results/widget-labels',
  use: { baseURL: origin, browserName: 'chromium', trace: 'retain-on-failure',
    extraHTTPHeaders: { Authorization: 'Bearer w29-owner-session' },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
})
