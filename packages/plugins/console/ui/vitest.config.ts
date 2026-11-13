import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['packages/plugins/console/ui/test/**/*.test.ts'], fileParallelism: false } })
