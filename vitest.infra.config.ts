import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { globalSetup: ['./packages/core/test/fixtures/config-era/provision-setup.ts'], environment: 'node', include: ['packages/core/test/infra/**/*.test.ts'], fileParallelism: false } })
