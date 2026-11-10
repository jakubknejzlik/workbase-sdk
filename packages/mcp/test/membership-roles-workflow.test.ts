import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { permissions } from '../../plugins/permissions/src/index'
import { Store, configSource } from '../src/storage'
import { Workflow } from '../src/workflow'
import { prepare } from '../src/planning'
import { applyDisposable } from '../src/disposable'
import { expectedSnapshot } from '../src/offline'
import type { Change } from '../src/schemas'

let root: string
let targetDirectory: string | undefined
let targetPath: string
let workflow: Workflow
let store: Store
const config = defineInstance({ id: 'role_workflow', revision: 1, interactive: false,
  plugins: [permissions({ roles: ['owner', 'viewer', 'reviewer'] })],
  entities: { assets: { fields: { name: { type: 'string' } } } },
  permissions: { owner: { assets: ['read'] } }, organizationPermissions: { owner: ['members.update'] },
})
beforeEach(async () => {
  root = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-roles-')))
  await mkdir(join(root, 'migrations'))
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(root, 'config.ts'), configSource(config))
  await writeFile(join(root, 'migrations/0001_initial.sql'), initialSchema(config))
  store = new Store(root); await store.init(); workflow = new Workflow(store)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  cleanupTempDir(root)
  if (targetDirectory) await rm(targetDirectory, { recursive: true, force: true })
  targetDirectory = undefined
})
async function accepted(name: string, args: object) {
  const result = await workflow.call(name, args)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  return result as Record<string, any>
}
async function proposal(changes: Change[]) {
  const { proposalId } = await accepted('propose_change', { instance: 'role-workflow', baseRevision: 1, changes })
  await accepted('validate', { proposalId })
  return proposalId
}
async function targetDatabase() {
  const bundle = await store.load('role-workflow')
  const prepared = prepare(bundle.config, [], [{ kind: 'set_organization_permissions', role: 'owner', actions: ['members.update'] }])
  const verification = await applyDisposable(bundle, prepared, expectedSnapshot(bundle, prepared), true)
  expect(verification.verified).toBe(true)
  targetDirectory = verification.directory!
  const directory = join(targetDirectory, 'persist/v3/d1/miniflare-D1DatabaseObject')
  targetPath = join(directory, (await readdir(directory)).find(name => name.endsWith('.sqlite'))!)
  vi.stubEnv('WORKBASE_MCP_ROLE_DATABASES', JSON.stringify({ 'role-workflow': targetPath }))
}
it('175 four role changes survive real D1 verification, promotion and permissions-provider reload', async () => {
  const proposalId = await proposal([
    { kind: 'add_role', role: 'operator' },
    { kind: 'set_permissions', entity: 'assets', role: 'operator', operations: ['read'] },
    { kind: 'set_organization_permissions', role: 'operator', actions: ['members.update'] },
    { kind: 'set_policy', entity: 'assets', role: 'operator', policy: 'all' },
  ])
  const preview = await accepted('preview_migration', { proposalId })
  expect(preview.sql).not.toMatch(/CREATE|ALTER|DROP|UPDATE|DELETE/)
  await accepted('apply_to_disposable', { proposalId })
  await accepted('promote', { proposalId, expectedRevision: 1 })
  const result = (await store.load('role-workflow')).config
  expect(result.roles).toContain('operator')
  expect(result.permissions.operator).toEqual({ assets: ['read'] })
  expect(result.organizationPermissions.operator).toEqual(['members.update'])
})
it('175 remove_role fails closed without a target DB and can retry with an unused role', async () => {
  vi.stubEnv('WORKBASE_MCP_ROLE_DATABASES', '{}')
  const proposalId = await proposal([{ kind: 'remove_role', role: 'reviewer' }])
  expect(await workflow.call('apply_to_disposable', { proposalId })).toMatchObject({ ok: false, error: { code: 'role_usage_unverified' } })
  await targetDatabase()
  await accepted('apply_to_disposable', { proposalId })
  await accepted('promote', { proposalId, expectedRevision: 1 })
  expect((await store.load('role-workflow')).config.roles).not.toContain('reviewer')
})
it.each(['memberships', 'invitations', 'access_tokens'])('175 remove_role checks target %s again at promotion, including historical rows', async table => {
  await targetDatabase()
  const proposalId = await proposal([{ kind: 'remove_role', role: 'reviewer' }])
  await accepted('apply_to_disposable', { proposalId })
  const db = new DatabaseSync(targetPath)
  try {
    db.exec("INSERT INTO organizations VALUES ('org','Org'); INSERT INTO users VALUES ('actor','actor@example.test','','','now');")
    if (table === 'memberships') db.exec("INSERT INTO memberships VALUES ('actor','org','reviewer');")
    if (table === 'invitations') db.exec("INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,revoked_at) VALUES ('i','org','recipient@example.test','reviewer','hash','2000','actor','2000');")
    if (table === 'access_tokens') db.exec("INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,expires_at,revoked_at,created_at) VALUES ('t','org','actor','Token','hash','prefix','reviewer','2000','2000','now');")
  } finally { db.close() }
  expect(await workflow.call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'role_in_use' } })
  expect((await store.load('role-workflow')).config.revision).toBe(1)
  expect(await workflow.call('apply_to_disposable', { proposalId })).toMatchObject({ ok: false, error: { code: 'role_in_use' } })
})
it('175 an unreadable or incomplete target database never proves role absence', async () => {
  const proposalId = await proposal([{ kind: 'remove_role', role: 'reviewer' }])
  for (const path of [join(root, 'missing.sqlite'), join(root, 'empty.sqlite')]) {
    if (path.endsWith('empty.sqlite')) new DatabaseSync(path).close()
    vi.stubEnv('WORKBASE_MCP_ROLE_DATABASES', JSON.stringify({ 'role-workflow': path }))
    expect(await workflow.call('apply_to_disposable', { proposalId })).toMatchObject({ ok: false, error: { code: 'role_usage_unverified' } })
  }
})

it('175 MCP dispatcher keeps explicit zero grants through promotion and provider reload', async () => {
  const proposalId = await proposal([{ kind: 'add_role', role: 'dispatcher' }])
  await accepted('preview_migration', { proposalId })
  await accepted('apply_to_disposable', { proposalId })
  await accepted('promote', { proposalId, expectedRevision: 1 })
  const result = (await store.load('role-workflow')).config
  expect(result.roles).toContain('dispatcher')
  expect(result.organizationPermissions.dispatcher).toEqual([])
  expect(result.permissions.dispatcher).toEqual({ assets: [] })
  expect(defineInstance(result).organizationPermissions.dispatcher).toEqual([])
})

it('175 MCP cannot add implicit owner authority when the configured owner is administrator', async () => {
  const model = defineInstance({ ...config, organizationOwnerRole: 'administrator',
    pluginConfig: { permissions: { roles: ['administrator', 'viewer', 'reviewer'], ownerRole: 'administrator' } },
    permissions: { administrator: config.permissions.owner }, organizationPermissions: { administrator: ['members.update'] } })
  await writeFile(join(root, 'config.ts'), configSource(model))
  const result = await workflow.call('propose_change', { instance: 'role-workflow', baseRevision: 1, changes: [{ kind: 'add_role', role: 'owner' }] })
  expect(result).toMatchObject({ ok: false, error: { code: 'builtin_role' } })
  const reloaded = (await store.load('role-workflow')).config
  expect(reloaded.revision).toBe(1)
  expect(reloaded.roles).not.toContain('owner')
  expect(reloaded.permissions.owner).toBeUndefined()
  expect(reloaded.organizationPermissions.owner).toBeUndefined()
})
