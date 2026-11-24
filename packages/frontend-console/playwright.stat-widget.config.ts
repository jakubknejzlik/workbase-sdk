import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'

export default defineConfig({
  testDir: './e2e', testMatch: 'stat-widget.spec.ts', workers: 1, retries: 0, timeout: 60_000,
  reporter: 'list', outputDir: process.env.STAT_WIDGET_OUTPUT ?? 'test-results/stat-widget',
  use: { baseURL: origin, browserName: 'chromium', trace: 'retain-on-failure' },
})
