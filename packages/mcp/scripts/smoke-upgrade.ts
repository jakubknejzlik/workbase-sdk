import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { cp, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkMcpUpgrade } from '../../../scripts/lib/mcp-upgrade-check'

const repo = resolve(import.meta.dirname, '../../..')
const root = registerTempDir(await mkdtemp(join(tmpdir(), 'workbase-upgrade-smoke-')))
const client = new Client({ name: 'sdk-upgrade-gate', version: '1' })
const transport = new StdioClientTransport({ command: 'bun', args: [join(repo, 'packages/mcp/src/bin.ts'), 'config', '--root', root], stderr: 'pipe',
  env: { ...process.env, WORKBASE_MCP_DEV_MODULE: '', WORKBASE_MCP_STATE_ROOT: join(root, 'state') } as Record<string, string> })
transport.stderr?.on('data', () => {})
try {
  await cp(join(repo, 'scripts/test/fixtures/sdk-0.2.1-revision-3'), root, { recursive: true })
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await client.connect(transport)
  await checkMcpUpgrade(client, root)
} finally {
  await client.close()
  await transport.close()
  cleanupTempDir(root)
}
