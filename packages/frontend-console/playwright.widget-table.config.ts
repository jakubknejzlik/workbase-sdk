import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'
export default defineConfig({ testDir: './e2e', testMatch: 'widget-table.spec.ts', workers: 1, retries: 0, timeout: 60_000,
  reporter: 'list', outputDir: process.env.WIDGET_TABLE_OUTPUT ?? 'test-results/widget-table',
  use: { baseURL: origin, browserName: 'chromium', trace: 'retain-on-failure' },
})
