import { defineConfig } from '@playwright/test'
import { origin } from './e2e/runtime/setup'
export default defineConfig({ testDir: './e2e', testMatch: 'worker-invitation.spec.ts', workers: 1, retries: 0, timeout: 30_000,
  reporter: [['list']], outputDir: process.env.WORKER_INVITATION_OUTPUT ?? 'test-results/worker-invitation',
  use: { baseURL: origin, browserName: 'chromium', trace: 'off',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
})
