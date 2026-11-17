import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['packages/plugins/console/ui/test/browser/acceptance.test.ts'], fileParallelism: false, hookTimeout: 60000 } })
