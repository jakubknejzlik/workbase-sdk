import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import type { TestProject } from 'vitest/node'

export default function setup(project: TestProject) {
  // Explicit state roots belong to the caller. Each other project owns a root.
  if (project.config.env.WORKBASE_MCP_STATE_ROOT !== undefined) return
  const root = registerTempDir(mkdtempSync(join(tmpdir(), 'workbase-mcp-state-')))
  project.config.env.WORKBASE_MCP_STATE_ROOT = root
  return () => cleanupTempDir(root)
}
