import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'
export default defineConfig({ testDir: './e2e', testMatch: 'widget-drilldown.spec.ts', workers: 1, retries: 0, timeout: 45_000,
  reporter: [['list']], outputDir: process.env.WIDGET_DRILLDOWN_OUTPUT ? `${process.env.WIDGET_DRILLDOWN_OUTPUT}/test-results` : 'test-results/widget-drilldown',
  use: { baseURL: origin, browserName: 'chromium', locale: 'en-US', trace: 'retain-on-failure',
    extraHTTPHeaders: { Authorization: 'Bearer w29-owner-session' },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
})
