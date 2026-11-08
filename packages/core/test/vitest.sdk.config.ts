import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

// SDK runtime tests own synthetic bindings; instance migration histories stay private.
export default defineConfig({
  plugins: [cloudflareTest({
    remoteBindings: false,
    miniflare: {
      compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
      queueProducers: { EVENTS_QUEUE: 'workbase-test-events' },
      kvNamespaces: ['AUDIT_KV', 'SERVICE_AUDIT_KV'],
      d1Databases: ['DB', 'SERVICE_DB', 'FRESH_DB', 'RECEIVER_DB'],
      bindings: { INTERNAL_TOKEN: 'synthetic-test-internal' },
    },
  })],
  test: {
    include: ['packages/core/test/**/*.test.ts', 'packages/plugins/*/test/**/*.test.ts'],
    exclude: ['packages/core/test/infra/**', '**/node_modules/**'],
    fileParallelism: false, testTimeout: 30000, hookTimeout: 30000,
  },
})
