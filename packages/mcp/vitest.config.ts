import { resolve as resolveDevModule } from 'node:path'
process.env.WORKBASE_MCP_DEV_MODULE = resolveDevModule('packages/mcp/test/fixtures/dev-module.ts')
import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    // Public ubuntu-24.04: 4 CPUs / 16 GB RAM. Heavy files need more than
    // the default ~4 GiB heap; isolated forks reclaim memory between files.
    pool: 'forks', isolate: true, maxWorkers: 1,
    execArgv: ['--max-old-space-size=6144'],
    globalSetup: [resolveDevModule('packages/mcp/test/temp-state-setup.ts')],
    projects: [
      { extends: true, test: { name: 'sdk', include: ['packages/mcp/test/**/*.test.ts'] } },
      ...(existsSync('apps/sdk-regressions/mcp') ? [{ extends: true as const, test: { name: 'private', include: ['apps/sdk-regressions/mcp/**/*.mcp.ts'], env: { WORKBASE_MCP_DEV_MODULE: resolveDevModule('packages/mcp/dev/fixture-plugins.ts') } } }] : []),
    ], fileParallelism: false, testTimeout: 120000, hookTimeout: 120000,
    env: process.env.WORKBASE_MCP_STATE_ROOT === undefined ? {} : { WORKBASE_MCP_STATE_ROOT: process.env.WORKBASE_MCP_STATE_ROOT },
  },
})
