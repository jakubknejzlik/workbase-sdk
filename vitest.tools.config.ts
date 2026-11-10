import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['scripts/sdk-publish.test.ts', 'scripts/check-sdk-boundary.test.ts', 'scripts/check-console-public.test.ts', 'scripts/lib/public-vocabulary.test.ts', 'scripts/check-core-enum-labels.test.ts', 'scripts/sdk-bootstrap-workflows.test.ts'], fileParallelism: false } })
