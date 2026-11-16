import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export const sdkMiniflare = {
  compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
  queueProducers: { EVENTS_QUEUE: 'workbase-test-events' },
  kvNamespaces: ['AUDIT_KV', 'SERVICE_AUDIT_KV'],
  d1Databases: ['DB', 'SERVICE_DB', 'FRESH_DB', 'RECEIVER_DB'],
  bindings: { INTERNAL_TOKEN: 'synthetic-test-internal' },
}

// SDK runtime tests own synthetic bindings; instance migration histories stay private.
export default defineConfig({
  plugins: [cloudflareTest({
    remoteBindings: false,
    miniflare: sdkMiniflare,
  })],
  test: {
    globalSetup: ['./packages/core/test/fixtures/config-era/provision-setup.ts'],
    include: ['packages/core/test/**/*.test.ts', 'packages/plugins/*/test/**/*.test.ts'],
    exclude: ['packages/core/test/infra/**', '**/node_modules/**', 'packages/core/test/operational-evidence-restart.test.ts'],
    fileParallelism: false, testTimeout: 30000, hookTimeout: 30000,
  },
})
