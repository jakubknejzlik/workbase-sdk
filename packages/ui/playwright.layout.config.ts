import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/browser',
  testMatch: 'data-table-layout.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/data-table-layout',
  use: { baseURL: 'http://127.0.0.1:4200', browserName: 'chromium' },
  webServer: {
    command: 'bun node_modules/vite/bin/vite.js test/browser --config vite.config.ts --host 127.0.0.1 --port 4200 --strictPort',
    cwd: import.meta.dirname,
    url: 'http://127.0.0.1:4200',
  },
})
