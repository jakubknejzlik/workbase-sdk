import { afterEach, expect, it } from 'vitest'
import { mkdtemp, realpath, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { bootstrapInstance } from '../src/bootstrap.ts'
import { runSchemaCli } from '@workbasehq/core/migrations/schema-cli'
import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '@workbasehq/core/schema/load'
import { createServer } from '../src/server.ts'
import { changeSchema } from '../src/schemas.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each([[], ['en', 'en'], ['de'], ['cs-CZ'], ['']].map(languages => ({ languages })))('rejects invalid console languages $languages', ({ languages }) => {
  expect(changeSchema.safeParse({ kind: 'set_locale', languages }).success).toBe(false)
})

it.each([
  { languages: ['en', 'cs'] },
  { locale: 'cs', defaultLanguage: 'cs' },
  { languages: ['cs', 'en'], locale: 'en', defaultLanguage: 'en' },
])('promotes V3 set_locale %j through config MCP without changing domain history', async settings => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'v3-languages-'))); roots.push(root)
  await bootstrapInstance(root, { id: 'demo', target: 'cloudflare-github' })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await runSchemaCli('plan', ['--root', root, '--init'])
  await runOpenApiCli(['--root', root, '--write'])
  if (settings.defaultLanguage === 'en') {
    // Cover an existing bound OpenAPI artifact and independently authored UI hints.
    const source = (await readFile(join(root, 'config.ts'), 'utf8'))
      .replace('entities: { worker }, access,', "entities: { worker }, access, ui: { entities: { worker: { list: { columns: ['name'] } } } },")
    await writeFile(join(root, 'config.ts'), source)
    await runOpenApiCli(['--root', root, '--write'])
  }
  const configBefore = await readFile(join(root, 'config.ts'), 'utf8')
  const preserved = ['runtime.ts', 'access.ts', 'schema/worker.ts', 'schema.lock.json', 'package.json',
    ...(await readdir(join(root, 'migrations'))).map(name => `migrations/${name}`)]
  const before = await Promise.all(preserved.map(path => readFile(join(root, path), 'utf8')))
  const app = await createServer({ root })
  const client = new Client({ name: 'v3-languages', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  // Exercise the installed workbase config stdio path under Bun as consumers do.
  const transport = settings.languages?.[0] === 'en' ? new StdioClientTransport({ command: 'bun', args: ['--no-install', resolve('packages/mcp/src/stdio.ts'), '--root', root], stderr: 'pipe' }) : a
  if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {})
  else await app.server.connect(b)
  await client.connect(transport)
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).structuredContent as any
  const { defaultLanguage, ...rest } = settings
  const expected = { ...rest, ...(defaultLanguage === undefined ? {} : { ui: { defaultLanguage } }) }
  try {
    expect(await call('propose_change', { instance: 'demo', baseRevision: 1, changes: [{ kind: 'set_locale', languages: ['en', 'cs'] }, { kind: 'set_plugin', plugin: 'console' }] })).toMatchObject({ ok: false, error: { code: 'mixed_change_kinds' } })
    const proposal = await call('propose_change', { instance: 'demo', baseRevision: 1, changes: [{ kind: 'set_locale', ...settings }] })
    expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true })
    const args = { proposalId: proposal.proposalId }
    expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
    expect(await call('validate', args)).toMatchObject({ ok: true })
    expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'verification_required' } })
    const preview = await call('preview_migration', args)
    expect(await call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(configBefore)
    expect(await call('promote', { ...args, expectedRevision: 999 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
    await writeFile(join(root, 'config.ts'), configBefore + '\n// changed since verification\n')
    expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
    await writeFile(join(root, 'config.ts'), configBefore)
    // Publication must consume persisted proofs after a server restart.
    const restarted = await createServer({ root })
    try {
      expect(await restarted.workflow.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1, appliesToDatabase: false })
      expect((await restarted.store.load('demo')).config).toMatchObject(expected)
    } finally { await restarted.server.close() }
    expect(preview).toMatchObject({ ok: true, revision: 1, sql: '' })
    expect(preview.files).toContainEqual({ path: 'config.ts', data: expect.any(String) })
    expect((await loadConfig(join(root, 'config.ts'))).config).toMatchObject({ ...expected, revision: 1, baseline: 'workbase-sdk' })
    expect(await call('inspect_schema', { instance: 'demo' })).toMatchObject(expected)
    const persisted = await readFile(join(root, 'config.ts'), 'utf8')
    expect(persisted).toContain('bindSchemaLock(defineConfig({')
    expect(await runSchemaCli('check', ['--root', root])).toBe(0)
    execFileSync('bun', ['run', 'check:access'], { cwd: root, encoding: 'utf8' })
    if (settings.defaultLanguage === 'en') {
      expect((await loadConfig(join(root, 'config.ts'))).config.ui?.entities.worker.list?.columns).toEqual(['name'])
      expect(await runOpenApiCli(['--root', root])).toBe(0)
    }
    expect(await call('submit_change', { instance: 'demo', proposalId: proposal.proposalId, expectedBaseSha: 'a'.repeat(40) })).toMatchObject({ ok: false, error: { code: 'github_not_configured' } })
    expect(persisted).toContain('// The literal model')
    expect(await Promise.all(preserved.map(path => readFile(join(root, path), 'utf8')))).toEqual(before)
    expect((await readdir(root)).filter(name => /^config\.v/.test(name))).toEqual([])
    expect(await call('validate', { instance: 'demo' })).toMatchObject({ ok: true, errors: [] })
  } finally { await client.close(); await transport.close(); await app.server.close() }
})
