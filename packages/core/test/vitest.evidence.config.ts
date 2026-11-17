import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { sdkMiniflare } from './vitest.sdk.config'

// Use the bundler already owned by the Workers test harness. No subprocess,
// deployment, persisted test service, or second database is involved.
const { buildSync } = createRequire(import.meta.resolve('@cloudflare/vitest-pool-workers'))('esbuild')
const script = buildSync({ entryPoints: [resolve('packages/core/test/fixtures/operational-reader.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*'], logLevel: 'silent' }).outputFiles[0].text
export default defineConfig({
  plugins: [cloudflareTest({
    remoteBindings: false,
    miniflare: {
      ...sdkMiniflare,
      d1Databases: { DB: 'operational-evidence-shared-db' },
      kvNamespaces: { AUDIT_KV: 'operational-evidence-shared-kv' },
      serviceBindings: { EVIDENCE_BEFORE: 'evidence-before', EVIDENCE_AFTER: 'evidence-after' },
      workers: ['evidence-before', 'evidence-after'].map(name => ({
        name, modules: true, script, compatibilityDate: sdkMiniflare.compatibilityDate,
        compatibilityFlags: sdkMiniflare.compatibilityFlags,
        d1Databases: { DB: 'operational-evidence-shared-db' },
        kvNamespaces: { AUDIT_KV: 'operational-evidence-shared-kv' },
        bindings: sdkMiniflare.bindings,
      })),
    },
  })],
  test: { include: ['packages/core/test/operational-evidence-restart.test.ts'], fileParallelism: false, testTimeout: 30000 },
})
