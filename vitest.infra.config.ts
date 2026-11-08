import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['packages/core/test/infra/**/*.test.ts'], fileParallelism: false } })
