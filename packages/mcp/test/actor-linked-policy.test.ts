import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { createServer } from '../src/server'
import { configSource } from '../src/storage'
import { prepare } from '../src/planning'
import type { Change } from '../src/schemas'

const base = defineInstance({ id: 'linkedpolicy', revision: 1, roles: ['owner', 'viewer'], account: { entity: 'users' },
  entities: { users: { fields: { name: { type: 'string' } } }, people: { fields: { name: { type: 'string' } } }, jobs: { fields: { title: { type: 'string' } } } },
  permissions: { viewer: { jobs: ['read'] } },
})
const policy = { where: { actorLinkedIn: 'people' } }
const changes: Change[] = [
  { kind: 'add_user_link', entity: 'people' },
  { kind: 'set_policy', entity: 'jobs', role: 'viewer', policy },
]
let root: string
let application: Awaited<ReturnType<typeof createServer>>
let client: Client
beforeEach(async () => {
  root = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-linked-policy-')))
  await mkdir(join(root, 'migrations'))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(root, 'config.ts'), configSource(base))
  await writeFile(join(root, 'migrations/0001_initial.sql'), initialSchema(base))
  application = await createServer({ root })
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'actor-linked-policy', version: '1' })
  await application.server.connect(b); await client.connect(a)
})
afterEach(async () => {
  await client?.close(); await application?.server.close()
  cleanupTempDir(root)
})
async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args })
  return response.structuredContent as Record<string, any>
}
it('MCP propose and validate preserve actorLinkedIn after adding a protected user link', async () => {
  const proposed = await call('propose_change', { instance: base.id, baseRevision: 1, changes })
  expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true })
  expect(await call('validate', { proposalId: proposed.proposalId })).toMatchObject({ ok: true, errors: [], revision: 2 })
  const prepared = prepare(base, [], changes)
  await writeFile(join(root, 'config.ts'), configSource(prepared.target))
  await writeFile(join(root, 'migrations/0002_linked_policy.sql'), prepared.sql)
  expect((await application.store.load(base.id)).config.policies.jobs.viewer).toEqual(policy)
  expect((await call('inspect_schema', { instance: base.id })).policies.jobs.viewer).toEqual(policy)
  expect(await call('validate', { instance: base.id })).toMatchObject({ ok: true, errors: [] })
})
it('MCP validate rejects actorLinkedIn on an entity without a protected user link', async () => {
  const proposed = await call('propose_change', { instance: base.id, baseRevision: 1, changes: [changes[1]] })
  expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true })
  const validated = await call('validate', { proposalId: proposed.proposalId })
  expect(validated.ok).toBe(false)
  expect(JSON.stringify(validated.errors)).toMatch(/actorLinkedIn.*protected user link/)
})
