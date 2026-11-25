import { defineConfig } from '@playwright/test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { origin } from './e2e/runtime/setup'

export default defineConfig({ testDir: './e2e', testMatch: 'metadata-list-cells.spec.ts', workers: 1, retries: 0, timeout: 90_000,
  reporter: [['list']], outputDir: join(tmpdir(), 'metadata-list-results'),
  use: { baseURL: origin, browserName: 'chromium', trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
})
