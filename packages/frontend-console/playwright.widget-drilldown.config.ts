import { defineConfig } from '@playwright/test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { origin } from './e2e/runtime/setup'
export default defineConfig({ testDir: './e2e', testMatch: 'widget-drilldown.spec.ts', workers: 1, retries: 0, timeout: 120_000,
  reporter: [['list']], outputDir: join(tmpdir(), 'widget-drilldown-results'),
  use: { baseURL: origin, browserName: 'chromium', locale: 'en-US', trace: 'retain-on-failure',
    extraHTTPHeaders: { Authorization: 'Bearer w29-owner-session' },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
})
