import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'
export default defineConfig({ testDir: './e2e', testMatch: 'runtime-model.spec.ts', workers: 1, retries: 0, timeout: 30_000,
  reporter: [['list']], outputDir: 'test-results/runtime', use: { baseURL: origin, browserName: 'chromium', trace: 'retain-on-failure' }, projects: [{ name: 'chromium' }],
})
