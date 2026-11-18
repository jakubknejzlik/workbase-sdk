import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'

export default defineConfig({
  testDir: './e2e', testMatch: 'saved-views-layout.spec.ts', workers: 1, retries: 0, timeout: 60_000,
  reporter: 'list', outputDir: 'test-results/saved-views-layout',
  use: { baseURL: origin, browserName: 'chromium', trace: 'retain-on-failure' },
})
