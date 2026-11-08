import { resolve as resolveDevModule } from 'node:path'
process.env.WORKBASE_MCP_DEV_MODULE = resolveDevModule('packages/mcp/test/fixtures/dev-module.ts')
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'
// Each test run owns a private disposable-state root: the suites assert that the root is left exactly as found, which is
// only true when no other run (CI runner, a second checkout, a review worktree) shares `/tmp/codex/mcp-state` concurrently.
const stateRoot = process.env.WORKBASE_MCP_STATE_ROOT ?? mkdtempSync(join(tmpdir(), 'workbase-mcp-state-'))
export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      { extends: true, test: { name: 'sdk', include: ['packages/mcp/test/**/*.test.ts'] } },
      ...(existsSync('apps/sdk-regressions/mcp') ? [{ extends: true as const, test: { name: 'private', include: ['apps/sdk-regressions/mcp/**/*.mcp.ts'], env: { WORKBASE_MCP_DEV_MODULE: resolveDevModule('packages/mcp/dev/fixture-plugins.ts') } } }] : []),
    ], fileParallelism: false, testTimeout: 120000, hookTimeout: 120000,
    env: { WORKBASE_MCP_STATE_ROOT: stateRoot },
  },
})
