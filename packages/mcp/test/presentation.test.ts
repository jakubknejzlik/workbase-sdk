import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from '../src/server.ts'
import { replaySources } from '../src/replay-sources.ts'
import { csCatalogChanges, csDomain, csUi } from './presentation-fixture.ts'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function stdio(root: string) {
  const client = new Client({ name: 'presentation-contract', version: '1' })
  const transport = new StdioClientTransport({ command: 'bun', args: ['--no-install', resolve('packages/mcp/src/stdio.ts'), '--root', root],
    stderr: 'pipe', env: { ...process.env, TMPDIR: tmpdir() } as Record<string, string> })
  const protocolErrors: string[] = []
  client.onerror = error => { protocolErrors.push(String(error)) }
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk.toString() })
  try { await client.connect(transport) } catch (error) { throw new Error(`${String(error)}: ${stderr}`) }
  return { call: async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
    expect(protocolErrors).toEqual([])
    expect(response.structuredContent, stderr).toBeDefined()
    return response.structuredContent as any
  }, close: async () => { await client.close(); await transport.close() } }
}
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'presentation-'))); roots.push(root)
  const session = await stdio(root)
  try {
    expect(await session.call('bootstrap_instance', { id: 'demo', target: 'cloudflare-github' })).toMatchObject({ ok: true })
    await fs.mkdir(join(root, 'node_modules'))
    // Provision the scaffold's explicit UI peers, which live in separate
    // workspace node_modules directories in this repository.
    for (const directory of ['node_modules', 'packages/plugins/node_modules', 'packages/frontend-console/node_modules']) {
      for (const name of await fs.readdir(resolve(directory))) {
        if (name.startsWith('.')) continue
        if (name.startsWith('@')) {
          await fs.mkdir(join(root, 'node_modules', name), { recursive: true })
          for (const child of await fs.readdir(resolve(directory, name))) {
            await fs.symlink(resolve(directory, name, child), join(root, 'node_modules', name, child)).catch(error => { if (error.code !== 'EEXIST') throw error })
          }
        } else await fs.symlink(resolve(directory, name), join(root, 'node_modules', name)).catch(error => { if (error.code !== 'EEXIST') throw error })
      }
    }
    const preview = await session.call('initialize_instance', { instance: 'demo' })
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true })
    const initialized = await session.call('initialize_instance', { instance: 'demo', mode: 'apply', planHash: preview.planHash })
    expect(initialized, JSON.stringify(initialized)).toMatchObject({ ok: true })
  } finally { await session.close() }
  return root
}
const catalog = (entries: Record<string, string>, language = 'en', namespace = 'domain') => ({ kind: 'set_catalog_entries', language, namespace, entries })
const bilingual = [{ kind: 'set_locale', languages: ['en', 'cs'], locale: 'cs' }, ...csCatalogChanges]
async function propose(call: Awaited<ReturnType<typeof stdio>>['call'], changes: unknown[] = bilingual) {
  const proposed = await call('propose_change', { instance: 'demo', baseRevision: 1, changes })
  expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, kind: 'composition_change' })
  return { proposalId: proposed.proposalId }
}
async function validate(call: Awaited<ReturnType<typeof stdio>>['call'], args: Record<string, unknown>) {
  const result = await call('validate', args)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, errors: [] })
}

it('publishes displayName and explicit EN/CS catalogs through stdio, consumes persisted proofs, and preserves source/history', async () => {
  const root = await fixture()
  let session = await stdio(root)
  try {
    const inspection = await session.call('inspect_schema', { instance: 'demo' })
    expect(inspection.dictionaries).toMatchObject({ languages: ['en'], catalogs: { en: { domain: { 'field.worker.name': 'Name' } } }, pluralCategories: { cs: expect.arrayContaining(['one', 'few', 'many', 'other']) } })
    expect(inspection.dictionaries.requiredKeys).toContainEqual({ key: 'domain:entity.worker', plural: true, sources: expect.arrayContaining([expect.objectContaining({ file: join(root, 'schema/worker.ts'), line: expect.any(Number) })]) })
    const paths = ['config.ts', 'runtime.ts', 'access.ts', 'schema/worker.ts', 'schema.lock.json', ...(await fs.readdir(join(root, 'migrations'))).map(name => `migrations/${name}`)]
    const before = await Promise.all(paths.map(path => fs.readFile(join(root, path))))
    const args = await propose(session.call, [{ kind: 'set_instance_display_name', displayName: '  Úklid 東京  ' }, ...bilingual, catalog({ 'field.worker.name': 'Full name' })])
    await validate(session.call, args)
    const preview = await session.call('preview_migration', args)
    expect(preview).toMatchObject({ ok: true, revision: 1, sql: '' })
    expect(preview.files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining(['config.ts', 'locales/en/domain.json', 'locales/cs/domain.json', 'locales/cs/ui.json']))
    expect(await session.call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true, diffs: [] })
    expect(await Promise.all(paths.map(path => fs.readFile(join(root, path))))).toEqual(before)
    await session.close(); session = await stdio(root)
    expect(await session.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1 })
    await session.close(); session = await stdio(root)
    expect(await session.call('inspect_schema', { instance: 'demo' })).toMatchObject({ revision: 1, displayName: 'Úklid 東京', languages: ['en', 'cs'], dictionaries: { catalogs: { cs: { domain: csDomain, ui: csUi }, en: { domain: { 'field.worker.name': 'Full name', 'field.worker.user': 'Application access' } } } } })
    const after = await Promise.all(paths.map(path => fs.readFile(join(root, path))))
    expect(after.slice(1)).toEqual(before.slice(1))
    for (const command of ['check:ui', 'typecheck', 'check:schema', 'check:access', 'check:openapi']) {
      execFileSync('bun', ['run', command], { cwd: root, stdio: 'pipe' })
    }
    expect(after[0].toString().match(/^import .*$/gm)).toEqual(before[0].toString().match(/^import .*$/gm))
    expect(after[0].toString()).toContain('bindSchemaLock(defineConfig({')
    for (const script of ['check:ui', 'typecheck', 'check:schema', 'check:access', 'check:openapi']) {
      execFileSync('bun', ['run', script], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    }
  } finally { await session.close() }
})

it('refuses missing Czech forms, interpolation drift, orphan keys and malformed catalogs with locations', async () => {
  const root = await fixture(), session = await stdio(root)
  try {
    const missing = await propose(session.call, [{ kind: 'set_locale', languages: ['en', 'cs'] }])
    expect(await session.call('validate', missing)).toMatchObject({ ok: false, error: { code: 'invalid_presentation', details: expect.arrayContaining([expect.objectContaining({ lang: 'cs', key: 'domain:entity.worker_many' })]) } })
    const { 'entity.worker_many': _many, ...withoutMany } = csDomain
    for (const [entries, code, key] of [
      [withoutMany, 'missing-key', 'domain:entity.worker_many'],
      [{ ...csDomain, 'entity.worker_many': '' }, 'invalid_input', ''],
      [{ ...csDomain, 'entity.worker_one': 'pracovník' }, 'interpolation', 'domain:entity.worker_one'],
      [{ ...csDomain, unused: 'Nepoužito' }, 'orphan-key', 'domain:unused'],
    ] as const) {
      const changes = [bilingual[0], catalog(entries, 'cs'), csCatalogChanges[1]]
      if (code === 'invalid_input') expect(await session.call('propose_change', { instance: 'demo', baseRevision: 1, changes })).toMatchObject({ ok: false, error: { code } })
      else {
        const args = await propose(session.call, changes)
        expect(await session.call('validate', args)).toMatchObject({ ok: false, error: { code: 'invalid_presentation', details: expect.arrayContaining([expect.objectContaining({ code, key })]) } })
      }
    }
    await fs.writeFile(join(root, 'locales/en/domain.json'), '{ malformed')
    expect(await session.call('propose_change', { instance: 'demo', baseRevision: 1, changes: [catalog({ 'field.worker.name': 'Name' })] })).toMatchObject({ ok: false, error: { code: 'invalid_catalog', message: expect.stringContaining('locales/en/domain.json') } })
  } finally { await session.close() }
})

it('binds catalog bytes, absent paths, checked UI modules and same-revision presentation receipts across restart', async () => {
  const root = await fixture(), session = await stdio(root)
  try {
    const args = await propose(session.call, [catalog({ 'field.worker.name': 'Name' })])
    await validate(session.call, args)
    expect(await session.call('apply_to_disposable', args)).toMatchObject({ ok: true })
    const domain = await fs.readFile(join(root, 'locales/en/domain.json'))
    const mutations = [
      async () => { await fs.writeFile(join(root, 'locales/en/domain.json'), '{}'); return async () => { await fs.writeFile(join(root, 'locales/en/domain.json'), domain) } },
      async () => { await fs.rm(join(root, 'locales/en/domain.json')); return async () => { await fs.writeFile(join(root, 'locales/en/domain.json'), domain) } },
      async () => { await fs.mkdir(join(root, 'locales/cs')); await fs.writeFile(join(root, 'locales/cs/ui.json'), '{}'); return async () => { await fs.rm(join(root, 'locales/cs'), { recursive: true }) } },
      async () => { const path = join(root, 'ui/nav.ts'), text = await fs.readFile(path); await fs.writeFile(path, Buffer.concat([text, Buffer.from('\n// changed\n')])); return async () => { await fs.writeFile(path, text) } },
      async () => { await fs.writeFile(join(root, 'ui/-new.ts'), 'export const changed = true'); return async () => { await fs.rm(join(root, 'ui/-new.ts')) } },
    ]
    for (const mutate of mutations) {
      const undo = await mutate(), restarted = await stdio(root)
      try { expect(await restarted.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } }) }
      finally { await restarted.close(); await undo() }
    }
    const competing = await propose(session.call, [catalog({ 'field.worker.name': 'Name' })])
    await validate(session.call, competing)
    expect(await session.call('apply_to_disposable', competing)).toMatchObject({ ok: true })
    expect(await session.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true })
    expect(await session.call('promote', { ...competing, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
  } finally { await session.close() }
})

it.each([
  { publication: 'same-name', change: { kind: 'set_instance_display_name', displayName: 'demo' }, displayName: 'demo' },
  { publication: 'renamed', change: { kind: 'set_instance_display_name', displayName: 'Renamed demo' }, displayName: 'Renamed demo' },
  { publication: 'catalog-only', change: catalog({ 'field.worker.name': 'Name' }), displayName: 'demo' },
])('rejects older catalog proof after a $publication publication across restart', async ({ change, displayName }) => {
  const root = await fixture()
  let session = await stdio(root)
  try {
    const older = await propose(session.call, [catalog({ 'field.worker.name': 'Older name' })])
    await validate(session.call, older)
    expect(await session.call('apply_to_disposable', older)).toMatchObject({ ok: true, verified: true })
    const newer = await propose(session.call, [change])
    await validate(session.call, newer)
    expect(await session.call('apply_to_disposable', newer)).toMatchObject({ ok: true, verified: true })
    expect(await session.call('promote', { ...newer, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1 })
    const paths = ['config.ts', 'locales/en/domain.json', `proposals/${older.proposalId}.json`, `proposals/${newer.proposalId}.json`]
    const before = await Promise.all(paths.map(path => fs.readFile(join(root, path))))
    await session.close(); session = await stdio(root)
    expect(await session.call('inspect_schema', { instance: 'demo' })).toMatchObject({ revision: 1, displayName })
    expect(await session.call('promote', { ...older, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'stale_revision' } })
    expect(await Promise.all(paths.map(path => fs.readFile(join(root, path))))).toEqual(before)
    expect((await replaySources(root, { presentation: true }))[`proposals/${newer.proposalId}.json`]).toEqual(before[3])
  } finally { await session.close() }
})

it('publishes dictionary-only updates without adding access/OpenAPI artifacts and rejects unsafe inputs', async () => {
  const root = await fixture(), session = await stdio(root)
  try {
    await fs.writeFile(join(root, 'config.ts'), (await fs.readFile(join(root, 'config.ts'), 'utf8')).replace("import spec from './openapi.json'\n", '').replace('bindOpenApi(bindSchemaLock(', 'bindSchemaLock(').replace('}), lock), spec)', '}), lock)'))
    for (const path of ['openapi.json', 'access.lock.json', 'access.lock.md']) await fs.rm(join(root, path))
    for (const change of [catalog({ '../escape': 'No' }), catalog({ 'field.worker.name': ' ' }), catalog({ 'field.worker.name': 'No' }, '../cs'), { ...catalog({ valid: 'No' }), path: 'config.ts' }, catalog({ valid: 'No' }, 'en', 'sdk'), catalog(JSON.parse('{"__proto__":"No"}'))]) {
      expect(await session.call('propose_change', { instance: 'demo', baseRevision: 1, changes: [change] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    }
    const args = await propose(session.call, [catalog({ 'field.worker.name': 'Full name' })])
    await validate(session.call, args)
    const preview = await session.call('preview_migration', args)
    expect(preview.files.map((file: { path: string }) => file.path)).toEqual(['locales/en/domain.json'])
    expect(await session.call('apply_to_disposable', args)).toMatchObject({ ok: true })
    expect(await session.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true })
    for (const path of ['openapi.json', 'access.lock.json', 'access.lock.md']) await expect(fs.stat(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.symlink(join(root, 'locales/en'), join(root, 'locales/cs'))
    expect(await session.call('propose_change', { instance: 'demo', baseRevision: 1, changes: csCatalogChanges })).toMatchObject({ ok: false, error: { code: 'unsafe_path' } })
  } finally { await session.close() }
})

it('rolls back interrupted catalog/config publication and owned new locale directories, then recovers after restart', async () => {
  const root = await fixture(), app = await createServer({ root })
  const call = (name: string, args: Record<string, unknown>) => app.workflow.call(name, args) as Promise<any>
  try {
    const args = await propose(call)
    await validate(call, args)
    expect(await call('apply_to_disposable', args)).toMatchObject({ ok: true })
    const config = await fs.readFile(join(root, 'config.ts'))
    const link = fs.link, unlink = fs.unlink
    let interrupted = false
    const linked = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      await link(from, to)
      if (String(to) === join(root, 'locales/cs/ui.json')) { interrupted = true; throw new Error('interrupted publication') }
    })
    const unlinked = vi.spyOn(fs, 'unlink').mockImplementation(async path => {
      if (interrupted && String(path) === join(root, 'locales/cs/ui.json')) throw new Error('interrupted rollback')
      await unlink(path)
    })
    syncBuiltinESMExports()
    expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false })
    expect(interrupted).toBe(true)
    expect(await fs.stat(join(root, 'proposals/.promotion.json'))).toBeDefined()
    linked.mockRestore(); unlinked.mockRestore(); syncBuiltinESMExports()
    await app.server.close()
    const restarted = await stdio(root)
    try {
      expect(await restarted.call('inspect_schema', { instance: 'demo' })).toMatchObject({ languages: ['en'], revision: 1 })
      expect(await fs.readFile(join(root, 'config.ts'))).toEqual(config)
      await expect(fs.stat(join(root, 'locales/cs'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(join(root, 'proposals/.promotion.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await restarted.call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true })
    } finally { await restarted.close() }
  } finally { await app.server.close() }
})

it('rechecks newly appearing UI inputs during publication and rolls back catalogs/config without losing the external input', async () => {
  const root = await fixture(), app = await createServer({ root })
  const call = (name: string, args: Record<string, unknown>) => app.workflow.call(name, args) as Promise<any>
  try {
    const args = await propose(call)
    await validate(call, args)
    expect(await call('apply_to_disposable', args)).toMatchObject({ ok: true })
    const config = await fs.readFile(join(root, 'config.ts'))
    const link = fs.link
    let changed = false
    const stub = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      await link(from, to)
      if (!changed && String(to) === join(root, 'config.ts')) {
        changed = true
        await fs.writeFile(join(root, 'ui/-late.ts'), 'export const value = true\n')
      }
    })
    syncBuiltinESMExports()
    expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'concurrent_modification' } })
    stub.mockRestore(); syncBuiltinESMExports()
    expect(changed).toBe(true)
    expect(await fs.readFile(join(root, 'config.ts'))).toEqual(config)
    expect(await fs.readFile(join(root, 'ui/-late.ts'), 'utf8')).toContain('value = true')
    await expect(fs.stat(join(root, 'locales/cs'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(join(root, 'proposals/.promotion.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await app.server.close() }
})


it('rejects presentation inputs changed between proof capture and staged UI validation', async () => {
  const root = await fixture(), app = await createServer({ root })
  const call = (name: string, args: Record<string, unknown>) => app.workflow.call(name, args) as Promise<any>
  try {
    const args = await propose(call)
    const load = app.store.load.bind(app.store)
    let changed = false
    vi.spyOn(app.store, 'load').mockImplementation(async (instance, options) => {
      const bundle = await load(instance, options)
      if (options?.canonicalRuntime && !changed) {
        changed = true
        await fs.appendFile(join(root, 'ui/nav.ts'), '\n// changed after snapshot\n')
      }
      return bundle
    })
    expect(await call('validate', args)).toMatchObject({ ok: false, error: { code: 'stale_revision', message: expect.stringContaining('ui/nav.ts') } })
    expect(changed).toBe(true)
    const saved = JSON.parse(await fs.readFile(join(root, 'proposals', `${args.proposalId}.json`), 'utf8'))
    expect(saved.validation).toBeUndefined()
    expect(saved.verification).toBeUndefined()
  } finally { await app.server.close() }
})


it('keeps schema inspection available with located diagnostics when UI declarations are invalid', async () => {
  const root = await fixture(), session = await stdio(root)
  try {
    await fs.writeFile(join(root, 'ui/nav.ts'), 'invalid !!! declaration')
    expect(await session.call('inspect_schema', { instance: 'demo' })).toMatchObject({
      ok: true, revision: 1, entities: { worker: expect.any(Object) },
      dictionaries: { languages: ['en'], requiredKeys: [], errors: expect.arrayContaining([
        expect.objectContaining({ code: 'source', file: join(root, 'ui/nav.ts') }),
      ]) },
    })
  } finally { await session.close() }
})
