import { csCatalogChanges } from './presentation-fixture.ts'
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '@workbasehq/core/schema/load'
import { runSchemaCli } from '@workbasehq/core/migrations/schema-cli'
import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
import { bootstrapInstance } from '../src/bootstrap.ts'
import { createServer } from '../src/server.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(depth = '') {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'v3-locale-regression-'))); roots.push(parent)
  const root = join(parent, depth)
  await mkdir(root, { recursive: true })
  await bootstrapInstance(root, { id: 'demo', target: 'cloudflare-github' })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await runSchemaCli('plan', ['--root', root, '--init'])
  await runOpenApiCli(['--root', root, '--write'])
  return root
}
async function connect(root: string) {
  const app = await createServer({ root })
  const client = new Client({ name: 'v3-locale-regressions', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await app.server.connect(b)
  await client.connect(a)
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).structuredContent as any,
    close: async () => { await client.close(); await app.server.close() },
  }
}
async function promote(call: Awaited<ReturnType<typeof connect>>['call'], changes: unknown[]) {
  const proposal = await call('propose_change', { instance: 'demo', baseRevision: 1, changes })
  expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true })
  const args = { proposalId: proposal.proposalId }
  const validation = await call('validate', args)
  expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true })
  expect(await call('apply_to_disposable', args)).toMatchObject({ ok: true, verified: true, diffs: [] })
  expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: true, status: 'promoted', revision: 1 })
}

it('typechecks the promoted standalone consumer source after set_locale', async () => {
  const root = await fixture()
  const file = join(root, 'config.ts')
  const diagnostics = () => {
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
      noEmit: true, skipLibCheck: true, resolveJsonModule: true,
      esModuleInterop: true, allowImportingTsExtensions: true,
    })
    return ['config.ts', 'access.ts', 'schema/worker.ts'].flatMap(path =>
      program.getSemanticDiagnostics(program.getSourceFile(join(root, path))).map(d => ({
        code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      })))
  }
  expect(diagnostics()).toEqual([])
  const { call, close } = await connect(root)
  try {
    await promote(call, [{ kind: 'set_locale', locale: 'cs' }])
    expect((await loadConfig(file)).config.locale).toBe('cs')
    expect(diagnostics()).toEqual([])
  } finally { await close() }
})

it.each([false, true])('rejects V3 locale mixed with legacy metadata before saving a proposal (reversed: %s)', async reversed => {
  const root = await fixture()
  const { call, close } = await connect(root)
  try {
    const before = await readdir(join(root, 'proposals'))
    const source = await readFile(join(root, 'config.ts'), 'utf8')
    const changes = [{ kind: 'set_locale', languages: ['en', 'cs'] },
      { kind: 'set_display_field', entity: 'worker', displayField: 'name' }]
    expect(await call('propose_change', { instance: 'demo', baseRevision: 1, changes: reversed ? changes.reverse() : changes }))
      .toMatchObject({ ok: false, error: { code: 'mixed_change_kinds' } })
    expect((await readdir(join(root, 'proposals'))).filter(path => path.endsWith('.json')))
      .toEqual(before.filter(path => path.endsWith('.json')))
    expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe(source)
    expect(await call('propose_change', { instance: 'demo', baseRevision: 1, changes: [
      { kind: 'set_locale', languages: ['en', 'cs'] }, { kind: 'set_locale', locale: 'cs' },
    ] })).toMatchObject({ ok: true, kind: 'composition_change' })
  } finally { await close() }
})

it.each(['', 'consumer/nested/app'])('promotes locale with SDK-relative imports at consumer depth %j and preserves import bytes', async depth => {
  const root = await fixture(depth)
  const parent = depth ? resolve(root, '../../..') : root
  await symlink(resolve('packages/core/src'), join(parent, 'sdk'))
  for (const file of ['config.ts', 'access.ts', 'schema/worker.ts']) {
    const target = join(root, file)
    const path = relative(dirname(target), join(parent, 'sdk/schema.ts'))
    const sdk = path.startsWith('.') ? path : `./${path}`
    await writeFile(target, (await readFile(target, 'utf8')).replaceAll('@workbasehq/core/schema', sdk))
  }
  // A bound artifact exercises the second staged interpretation during OpenAPI generation.
  await runOpenApiCli(['--root', root, '--write'])
  const source = await readFile(join(root, 'config.ts'), 'utf8')
  expect((await loadConfig(join(root, 'config.ts'))).config.languages).toEqual(['en'])
  const preserved = ['access.ts', 'schema/worker.ts', 'schema.lock.json']
  const before = await Promise.all(preserved.map(path => readFile(join(root, path), 'utf8')))
  const { call, close } = await connect(root)
  try {
    await promote(call, [{ kind: 'set_locale', languages: ['en', 'cs'] }, ...csCatalogChanges])
    const after = await readFile(join(root, 'config.ts'), 'utf8')
    expect(after.match(/^import .*$/gm)).toEqual(source.match(/^import .*$/gm))
    expect(await Promise.all(preserved.map(path => readFile(join(root, path), 'utf8')))).toEqual(before)
    const loaded = await loadConfig(join(root, 'config.ts'))
    expect(loaded.config.languages).toEqual(['en', 'cs'])
    expect(JSON.parse(await readFile(join(root, 'openapi.json'), 'utf8'))['x-workbase-config-hash']).toBe(loaded.configHash)
    expect(await runOpenApiCli(['--root', root])).toBe(0)
  } finally { await close() }
})
