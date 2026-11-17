import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadConfig } from '@workbasehq/core/schema/load'
import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
import { createServer } from '../src/server.ts'
import { replayBundle, replayEngine } from '../src/offline.ts'
import { pluginLedger } from '../src/composition/plan.ts'
import { schemas } from '../src/schemas.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function empty() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'v3-instance-name-')))
  roots.push(root)
  return root
}
async function connect(root: string) {
  const client = new Client({ name: 'v3-instance-name', version: '1' })
  const transport = new StdioClientTransport({ command: 'node', args: [
    '--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs'),
    resolve('packages/mcp/src/stdio.ts'), '--root', root,
  ], stderr: 'pipe', env: { TMPDIR: tmpdir(), WORKBASE_MCP_STATE_ROOT: process.env.WORKBASE_MCP_STATE_ROOT ?? join(tmpdir(), 'workbase-instance-name-state') } })
  transport.stderr?.on('data', () => {})
  await client.connect(transport)
  return {
    client,
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).structuredContent as any,
    close: async () => { await client.close(); await transport.close() },
  }
}
async function fixture(displayName?: string) {
  const root = await empty()
  const connection = await connect(root)
  try {
    const tools = (await connection.client.listTools()).tools
    expect(tools.find(tool => tool.name === 'bootstrap_instance')?.inputSchema.properties).toHaveProperty('displayName')
    expect(JSON.stringify(tools.find(tool => tool.name === 'propose_change')?.inputSchema)).toContain('set_instance_display_name')
    expect(await connection.call('bootstrap_instance', { id: 'cleaning', target: 'cloudflare-github', ...(displayName === undefined ? {} : { displayName }) })).toMatchObject({ ok: true })
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    const preview = await connection.call('initialize_instance', { instance: 'cleaning', mode: 'preview' })
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true })
    expect(await connection.call('initialize_instance', { instance: 'cleaning', mode: 'apply', planHash: preview.planHash })).toMatchObject({ ok: true })
  } finally { await connection.close() }
  return root
}
async function snapshot(root: string) {
  const paths = ['runtime.ts', 'access.ts', 'schema/worker.ts', 'schema.lock.json', 'package.json',
    ...(await readdir(join(root, 'migrations'))).map(name => `migrations/${name}`)]
  const app = await createServer({ root })
  try {
    const bundle = await app.store.load('cleaning')
    return {
      id: bundle.config.id, revision: bundle.config.revision,
      files: await Promise.all(paths.map(async path => [path, await readFile(join(root, path), 'utf8')])),
      ledger: await replayBundle(bundle, pluginLedger),
      grants: replayEngine(bundle.config, bundle.runtime).kernel.config.effectiveAccess,
    }
  } finally { await app.server.close() }
}
const rename = (displayName: string) => ({ kind: 'set_instance_display_name', displayName })
async function propose(call: Awaited<ReturnType<typeof connect>>['call'], changes: unknown[]) {
  const result = await call('propose_change', { instance: 'cleaning', baseRevision: 1, changes })
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, kind: 'composition_change' })
  return { proposalId: result.proposalId }
}

it.each([undefined, 'Cleaning'])('bootstraps cleaning with displayName %j through discovered MCP and preserves create-only conflicts', async displayName => {
  const root = await fixture(displayName)
  const { call, close } = await connect(root)
  try {
    expect(await call('inspect_schema', { instance: 'cleaning' })).toMatchObject({ ok: true, instance: 'cleaning', displayName: displayName ?? 'cleaning', revision: 1 })
    const before = await readFile(join(root, 'config.ts'), 'utf8')
    const retry = await call('bootstrap_instance', { id: 'cleaning', displayName: 'Another name', target: 'cloudflare-github' })
    expect(retry.files).toContainEqual({ path: 'config.ts', status: 'conflict' })
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(before)
  } finally { await close() }
})

it.each([
  { name: 'Cleaning', absent: false },
  { name: '  Úklid 東京 🧹  ', absent: true },
  { name: 'Quotes " \\ ${data} {{INSTANCE_ID}} $& $` $\' ', absent: false },
  { name: 'N'.repeat(1000), absent: false },
])('promotes safe displayName with absent literal $absent and inspects after process restart', async ({ name, absent }) => {
  const root = await fixture()
  if (absent) {
    await writeFile(join(root, 'config.ts'), (await readFile(join(root, 'config.ts'), 'utf8')).replace(', displayName: "cleaning"', ''))
    await runOpenApiCli(['--root', root, '--write'])
  }
  const before = await snapshot(root), source = await readFile(join(root, 'config.ts'), 'utf8')
  const connection = await connect(root)
  try {
    const args = await propose(connection.call, [rename(name)])
    expect(await connection.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
    expect(await connection.call('validate', args)).toMatchObject({ ok: true })
    expect(await connection.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'verification_required' } })
    const preview = await connection.call('preview_migration', args)
    expect(preview).toMatchObject({ ok: true, revision: 1, sql: '', pluginSql: '' })
    expect(preview.pluginMigrations.every((row: any) => row.status === 'applied')).toBe(true)
    expect(preview.files.map((file: any) => file.path).sort()).toEqual(['access.lock.json', 'access.lock.md', 'config.ts', 'openapi.json'])
    const edited = preview.files.find((file: any) => file.path === 'config.ts').data
    if (!absent) expect(edited).toBe(source.replace('"cleaning"', () => JSON.stringify(name.trim())))
    else expect(edited).toContain(`"displayName": ${JSON.stringify(name.trim())}`)
    expect(await connection.call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(source)
    expect(await connection.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true, revision: 1, status: 'promoted' })
    expect(await connection.call('submit_change', { instance: 'cleaning', ...args, expectedBaseSha: 'a'.repeat(40) })).toMatchObject({ ok: false, error: { code: 'github_not_configured' } })
  } finally { await connection.close() }
  const restarted = await connect(root)
  try {
    expect(await restarted.call('inspect_schema', { instance: 'cleaning' })).toMatchObject({ ok: true, instance: 'cleaning', displayName: name.trim(), revision: 1 })
    expect(await restarted.call('validate', { instance: 'cleaning' })).toMatchObject({ ok: true, errors: [] })
  } finally { await restarted.close() }
  expect(await snapshot(root)).toEqual(before)
  expect((await readdir(root)).filter(path => /^config\.v/.test(path))).toEqual([])
  const loaded = await loadConfig(join(root, 'config.ts'))
  expect(loaded.config.displayName).toBe(name.trim())
  expect(JSON.parse(await readFile(join(root, 'openapi.json'), 'utf8'))['x-workbase-config-hash']).toBe(loaded.configHash)
  expect(await runOpenApiCli(['--root', root])).toBe(0)
  execFileSync('bun', ['run', 'check:access'], { cwd: root, encoding: 'utf8' })
})

it('rejects invalid names and mixed batches without saving proposals or publishing authored files', async () => {
  const root = await fixture()
  const connection = await connect(root)
  try {
    const source = await readFile(join(root, 'config.ts'), 'utf8'), before = await snapshot(root)
    const records = (await readdir(join(root, 'proposals'))).filter(path => path.endsWith('.json'))
    for (const displayName of [undefined, null, 42, '', ' \n\t ', 'n'.repeat(1001)]) {
      const response = await connection.call('propose_change', { instance: 'cleaning', baseRevision: 1, changes: [{ kind: 'set_instance_display_name', displayName }] })
      expect(response).toMatchObject({ ok: false })
      // Bootstrap uses the same strict text boundary, before creating anything.
      if (displayName !== undefined) {
        const target = await empty()
        const app = await connect(target)
        try {
          expect(await app.call('bootstrap_instance', { id: 'cleaning', displayName, target: 'cloudflare-github' })).toMatchObject({ ok: false })
          expect(await readdir(target)).toEqual([])
        } finally { await app.close() }
      }
    }
    expect(await connection.call('propose_change', { instance: 'cleaning', baseRevision: 1, changes: [{ ...rename('Cleaning'), extra: true }] })).toMatchObject({ ok: false })
    for (const other of [
      { kind: 'set_plugin', plugin: 'console' }, { kind: 'set_interactive', interactive: false },
      { kind: 'set_system_access', role: 'staff', grants: {} },
      { kind: 'set_display_field', entity: 'worker', displayField: 'name' },
      { kind: 'add_role', role: 'viewer' },
    ]) for (const changes of [[rename('Cleaning'), other], [other, rename('Cleaning')]]) {
      for (const tool of ['propose_change', 'propose_composition']) {
        expect(await connection.call(tool, { instance: 'cleaning', baseRevision: 1, changes })).toMatchObject({ ok: false })
      }
    }
    expect((await readdir(join(root, 'proposals'))).filter(path => path.endsWith('.json'))).toEqual(records)
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(source)
    expect(await snapshot(root)).toEqual(before)
    expect(await propose(connection.call, [rename('Cleaning'), { kind: 'set_locale', locale: 'cs' }])).toHaveProperty('proposalId')
  } finally { await connection.close() }
})

it('rejects a same-revision fingerprint change after disposable verification', async () => {
  const root = await fixture(), connection = await connect(root)
  try {
    const args = await propose(connection.call, [rename('Cleaning')])
    expect(await connection.call('validate', args)).toMatchObject({ ok: true })
    expect(await connection.call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true })
    const source = await readFile(join(root, 'config.ts'), 'utf8') + '\n// concurrent presentation edit\n'
    await writeFile(join(root, 'config.ts'), source)
    expect((await loadConfig(join(root, 'config.ts'))).config.revision).toBe(1)
    expect(await connection.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(source)
  } finally { await connection.close() }
})

it('revokes verification on a cancelled disposable run and refuses publication', async () => {
  const root = await fixture(), connection = await connect(root)
  try {
    const source = await readFile(join(root, 'config.ts'), 'utf8'), before = await snapshot(root)
    const args = await propose(connection.call, [rename('Cleaning')])
    expect(await connection.call('validate', args)).toMatchObject({ ok: true })
    expect(await connection.call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true })
    const app = await createServer({ root })
    try {
      const cancelled = new AbortController(); cancelled.abort()
      expect(await app.workflow.call('apply_to_disposable', args, cancelled.signal)).toMatchObject({ ok: false, verified: false })
    } finally { await app.server.close() }
    expect(await connection.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'verification_required' } })
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(source)
    expect(await snapshot(root)).toEqual(before)
  } finally { await connection.close() }
})

it('promotes a name/locale batch without introducing OpenAPI when the graph has none', async () => {
  const root = await fixture()
  const source = (await readFile(join(root, 'config.ts'), 'utf8'))
    .replace(', bindOpenApi', '').replace("import spec from './openapi.json'\n", '')
    .replace('bindOpenApi(bindSchemaLock(', 'bindSchemaLock(').replace('}), lock), spec)', '}), lock)')
  await writeFile(join(root, 'config.ts'), source)
  await rm(join(root, 'openapi.json'))
  const connection = await connect(root)
  try {
    const args = await propose(connection.call, [rename('Cleaning'), { kind: 'set_locale', locale: 'cs' }])
    expect(await connection.call('validate', args)).toMatchObject({ ok: true })
    const preview = await connection.call('preview_migration', args)
    expect(preview.files.map((file: any) => file.path)).not.toContain('openapi.json')
    expect(await connection.call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true })
    expect(await connection.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true, revision: 1 })
    expect(await connection.call('inspect_schema', { instance: 'cleaning' })).toMatchObject({ displayName: 'Cleaning', locale: 'cs' })
    expect(await readFile(join(root, 'openapi.json')).catch(() => undefined)).toBeUndefined()
  } finally { await connection.close() }
})

it('forwards the optional CLI bootstrap name with safe serialization', async () => {
  const root = await empty(), name = '  Úklid " \\ ${value} {{INSTANCE_ID}} $&  '
  const output = execFileSync('bun', ['--no-install', resolve('packages/mcp/src/bin.ts'), 'init', '--root', root, '--id', 'cleaning', '--target', 'cloudflare-github', '--display-name', name], { encoding: 'utf8' })
  expect(JSON.parse(output)).toMatchObject({ ok: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  expect((await loadConfig(join(root, 'config.ts'))).config).toMatchObject({ id: 'cleaning', displayName: name.trim() })
  expect(schemas.bootstrap_instance.safeParse({ id: 'cleaning', displayName: 'Cleaning', extra: true, target: 'cloudflare-github' }).success).toBe(false)
})
