import { createRequire } from 'node:module'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import SwaggerParser from '@apidevtools/swagger-parser'
import { generate } from '../../src/openapi/generate'
import { runOpenApiCli } from '../../src/openapi/cli'
import { canonical } from '../../src/access-lock'
import { instanceConfigSchema, fieldSchema, cloneInstanceConfig, CORE_VERSION, Q, Fn } from '../../src/config'
import { declarationSchema } from '../../src/schema'
import { publicSchema } from '../../src/public-schema'
import { publicQuery } from '../../src/public-projection'
import { KernelRegistry } from '../../src/kernel/registry'
import { loadConfig } from '../../src/schema/load'
import { workerAccessFixture } from '../fixtures/worker-access'
import { loadPrivateTerms } from '../../../../scripts/lib/private-terms'

const root = resolve('packages/core/test/fixtures/worker-access')
const hash = '0'.repeat(64)
const fixture = () => new KernelRegistry(workerAccessFixture())
const bytes = (kernel = fixture()) => generate(kernel.config, kernel, hash)
// Use the parser's existing Ajv 2020 dependency, rather than a second validator install.
const require = createRequire(import.meta.url)
const Ajv = createRequire(require.resolve('@apidevtools/swagger-parser'))('ajv/dist/2020')
function validate(doc: any, schema: any, data: unknown) {
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true })
  const check = ajv.compile({ ...schema, components: doc.components })
  expect(check(data), JSON.stringify(check.errors)).toBe(true)
  return check
}
it('pins the current successful /schema fixture bytes across shared projection extraction', async () => {
  expect(JSON.stringify(publicSchema(workerAccessFixture(), {}))).toBe(await readFile(join(root, 'schema.public.json'), 'utf8'))
  const config = workerAccessFixture()
  config.commands = ['probe']
  const command = { name: 'probe', permission: { entity: 'worker', operation: 'update' }, additionalPermissions: [], input: z.object({ name: z.string().default('synthetic-access-secret-at-least-32') }), ui: { title: 'Probe' } } as any
  expect(JSON.stringify(publicSchema(config, { commands: new Map([['probe', command]]) }))).toBe(await readFile(join(root, 'schema.commands.public.json'), 'utf8'))
  // Preserve the pre-existing transform error rather than changing a runtime contract.
  const kernel = fixture()
  expect(() => publicSchema(kernel.config, kernel)).toThrow('Transforms cannot be represented')
})
it('validates 3.1, rejects broken documents, and round-trips exact canonical bytes', async () => {
  const text = bytes(), doc = JSON.parse(text)
  expect(JSON.stringify(canonical(JSON.parse(text)), null, 2) + '\n').toBe(text)
  await SwaggerParser.validate(structuredClone(doc))
  await expect(SwaggerParser.validate({ ...structuredClone(doc), info: { title: 'broken' } })).rejects.toThrow()
  expect(doc.info.version).toBe('r1')
  expect(text).not.toContain(CORE_VERSION)
  expect(text).not.toMatch(/"servers"|"const"|"examples"|file:line|\/Users\/|"conditional"|"opaqueHooks"|"predicates"/)
  expect(doc['x-workbase-query']).toEqual(publicQuery(fixture().config))
  expect(doc['x-workbase-permissions'].entities).toEqual(publicSchema(fixture().config, {}).policies)
  expect(Object.keys(doc.paths).sort()).toEqual([
    '/api/users', '/api/users/{id}', '/api/worker', '/api/worker/{id}',
    ...['invite', 'cancel_invite', 'link_account', 'unlink_account'].map(action => `/api/worker/{id}/actions/${action}`),
    ...fixture().config.commands.map(name => `/commands/${name}`),
    '/query', '/o/{org}/capabilities', '/me', '/orgs/{orgId}/members', '/me/invitations', '/invitations/preflight', '/invitations/resolve', '/invitations/{id}/resolve', '/invitations/{id}/accept', '/invitations/{id}/decline', '/me/profile', '/auth/providers', '/auth/logout', '/auth/sign-in/magic-link', '/build.json', '/health', '/openapi.json',
  ].sort())
})
it('validates recorded detail fixtures and rejects malformed or leaking responses', async () => {
  const doc = JSON.parse(bytes())
  const schema = doc.paths['/api/worker/{id}'].get.responses['200'].content['application/json'].schema
  for (const state of ['no_account', 'invited', 'expired', 'linked']) {
    const sample = JSON.parse(await readFile(join(root, `detail.${state}.json`), 'utf8'))
    const check = validate(doc, schema, sample)
    expect(check({ ...sample, access: { ...sample.access, state: 'invented' } })).toBe(false)
    expect(check({ ...sample, token_hash: 'synthetic-access-secret-at-least-32' })).toBe(false)
    expect(check({ ...sample, actions: { invite: { enabled: 'yes' } } })).toBe(false)
  }
})
it('describes request grammar, disjoint entities, both cursor contracts and mutation headers', () => {
  const doc = JSON.parse(bytes())
  const request = doc.paths['/query'].post.requestBody.content['application/json'].schema
  const check = validate(doc, request, { entity: 'worker', limit: 2, where: { name: { contains: 'Ja' } }, select: ['id'] })
  expect(check({ entity: 'worker', limit: 0 })).toBe(false)
  expect(check({ entity: 'missing', limit: 1 })).toBe(false)
  expect(check({ entity: 'worker', limit: 1, where: { name: { unknown: 'x' } } })).toBe(false)
  expect(doc.components.schemas.List_worker.properties.next_cursor.description).toContain('last returned row id')
  expect(doc.components.schemas.Result_worker.properties.next_cursor.description).toContain('Opaque signed')
  expect(doc.paths['/api/worker'].post.parameters[0].name).toBe('Idempotency-Key')
  expect(doc.paths['/api/worker/{id}'].patch.parameters[0].name).toBe('If-Match')
  expect(doc.paths['/api/worker/{id}'].delete.responses['204']).not.toHaveProperty('content')
  const update = new Ajv({ strict: false, validateFormats: false }).compile(doc.components.schemas.Update_worker)
  expect(update({ version: 1 })).toBe(false)
  expect(update({ name: 'Jana', version: 1 })).toBe(true)
  expect(update({ name: '' })).toBe(false)
  for (const name of ['invite', 'cancel_invite', 'link_account', 'unlink_account']) {
    const component = doc.paths[`/api/worker/{id}/actions/${name}`].post.requestBody.content['application/json'].schema.$ref.split('/').at(-1)
    const action = doc.components.schemas[component]
    expect(action.properties).not.toHaveProperty('id')
    const invalid = new Ajv({ strict: false, validateFormats: false }).compile(action)
    expect(invalid({ id: 'forged' })).toBe(false)
  }
})
it('sorts set-like declarations without sorting authored enums and never mutates inputs', () => {
  const kernel = fixture(), config = cloneInstanceConfig(kernel.config)
  const before = JSON.stringify(config)
  const original = generate(config, kernel, hash)
  expect(JSON.stringify(config)).toBe(before)
  config.roles.reverse()
  config.commands.reverse()
  for (const resources of Object.values(config.permissions)) for (const operations of Object.values(resources)) operations.reverse()
  for (const entity of Object.values(config.entities)) entity.fields = Object.fromEntries(Object.entries(entity.fields).reverse())
  expect(generate(config, kernel, hash)).toBe(original)
  config.entities.worker.fields.kind = { type: 'enum', required: false, values: ['z', 'a'] }
  expect(JSON.parse(generate(config, kernel, hash)).components.schemas.Row_worker.properties.kind.anyOf[0].enum).toEqual(['z', 'a'])
})
it('canaries every excluded Zod config/entity/field key, environment, effective-policy internals and input defaults', () => {
  const canary = 'synthetic-access-secret-at-least-32'
  const kernel = fixture(), config = cloneInstanceConfig(kernel.config)
  const allow = ['id', 'revision', 'entities', 'roles', 'permissions', 'commands', 'policies']
  const checked: string[] = []
  for (const key of Object.keys(instanceConfigSchema.shape)) if (!allow.includes(key)) {
    // The generator is deliberately exercised with poisoned, already-normalized data.
    ;(config as any)[key] = canary
    checked.push(key)
  }
  const publicEntity = ['fields', 'relations', 'displayField', 'actions', 'access', 'commandsOnly']
  for (const key of new Set([...Object.keys(instanceConfigSchema.shape.entities.valueType.shape), ...Object.keys(declarationSchema.shape)])) if (!publicEntity.includes(key)) {
    ;(config.entities.worker as any)[key] = canary
    checked.push(`entities.*.${key}`)
  }
  // Restore label AST: dependencies are public field names; expression literal values are private.
  delete config.entities.worker.label
  const publicField = ['type', 'required', 'values', 'entity', 'readOnly', 'sensitive', 'min', 'ui']
  for (const key of Object.keys(fieldSchema.shape)) if (!publicField.includes(key)) {
    ;(config.entities.worker.fields.name as any)[key] = canary
    checked.push(`entities.*.fields.*.${key}`)
  }
  config.entities.worker.fields.name.computed = Fn.concat('id', Q.value(canary)).serialize()
  config.entities.worker.actions = { private: { command: canary, available: [{ when: { [canary]: canary }, reason: canary }] } }
  for (const rule of config.effectiveAccess!.entities) { rule.where = { private: canary }; rule.predicates = [canary]; rule.source = canary; rule.dependencies = [canary] }
  for (const action of config.effectiveAccess!.actions) { action.source = canary; action.dependencies = [canary]; for (const condition of action.conditions) Object.assign(condition, { when: { private: canary }, kind: canary, opaque: canary }) }
  config.effectiveAccess!.opaqueHooks = [canary]
  const input = z.object({ example: z.string().default(canary), secret: z.string().meta({ sensitive: true, description: canary, examples: [canary] }), literal: z.literal(canary) })
  const command = { ...kernel.commands.values().next().value!, name: 'probe', input, ui: { label: canary } }
  config.commands = [...kernel.config.commands, 'probe']
  const registry = { commands: new Map([...kernel.commands, ['probe', command]]), workflows: new Map([['probe', { name: 'probe', version: 1, input, steps: [] } as any]]) }
  const previous = process.env.OPENAPI_PROBE
  process.env.OPENAPI_PROBE = canary
  try { expect(generate(config, registry, hash)).not.toContain(canary) }
  finally { if (previous === undefined) delete process.env.OPENAPI_PROBE; else process.env.OPENAPI_PROBE = previous }
  expect(checked.length).toBeGreaterThan(20)
})
it('checks private vocabulary over the committed fixture with loadPrivateTerms', async () => {
  const terms = loadPrivateTerms()
  const { buildGuardRegexes } = await import('../../../../scripts/lib/public-vocabulary')
  expect(buildGuardRegexes(terms).customerTerms.test(await readFile(join(root, 'openapi.json'), 'utf8'))).toBe(false)
})
it('CLI detects missing, stale and edited-field drift; check never writes; --write repairs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbase-openapi-'))
  // Keep package resolution inside the worktree when importing copied config modules.
  const temp = resolve('packages/core/test/fixtures', directory.split('/').at(-1)!)
  try {
    await cp(root, temp, { recursive: true })
    const args = ['--config', join(temp, 'config.ts')]
    const original = await readFile(join(temp, 'openapi.json'), 'utf8')
    expect(await runOpenApiCli(args)).toBe(0)
    await writeFile(join(temp, 'schema/worker.ts'), (await readFile(join(temp, 'schema/worker.ts'), 'utf8')).replace("type: 'text'", "type: 'string'"))
    expect(await runOpenApiCli(args)).toBe(1)
    expect(await readFile(join(temp, 'openapi.json'), 'utf8')).toBe(original)
    await rm(join(temp, 'openapi.json'))
    expect(await runOpenApiCli(args)).toBe(1)
    expect(await runOpenApiCli([...args, '--write'])).toBe(0)
    expect(await runOpenApiCli(args)).toBe(0)
    await expect(runOpenApiCli(['--live', 'https://example.test'])).rejects.toThrow('Usage')
  } finally { await rm(temp, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }) }
})
it('the literal loader fixture has the same worker/account public schema and policy as the runtime fixture', async () => {
  const { config, configHash } = await loadConfig(join(root, 'config.ts'))
  const kernel = new KernelRegistry(config), runtime = fixture()
  expect(JSON.parse(generate(kernel.config, kernel, hash))).toEqual(JSON.parse(bytes(runtime)))
  expect(configHash).toHaveLength(64)
  expect(await runOpenApiCli(['--config', join(root, 'config.ts')])).toBe(0)
})

it('rebases recursive registered command and workflow input references into the document', async () => {
  const kernel = fixture(), config = cloneInstanceConfig(kernel.config)
  const tree: z.ZodType = z.object({ name: z.string(), $schema: z.string().optional(), default: z.string().optional(), children: z.array(z.lazy(() => tree)).optional() })
  const command = { ...kernel.commands.values().next().value!, name: 'worker/tree', input: tree }
  config.commands.push(command.name)
  const registry = { commands: new Map([...kernel.commands, [command.name, command]]), workflows: new Map([['tree', { name: 'tree', version: 1, input: tree, steps: [] } as any]]) }
  const doc = JSON.parse(generate(config, registry, hash))
  expect(doc['x-workbase-commands'].find((item: any) => item.name === 'worker/tree').inputSchema.properties.children.items.$ref).toBe('#/components/schemas/CommandInput_worker_tree')
  expect(doc['x-workbase-workflows'][0].inputSchema.properties.children.items.$ref).toBe('#/components/schemas/WorkflowInput_tree')
  await SwaggerParser.validate(structuredClone(doc))
  const schema = doc.paths['/commands/worker/tree'].post.requestBody.content['application/json'].schema
  const check = validate(doc, schema, { name: 'root', $schema: 'named property', default: 'named property', children: [{ name: 'leaf', $schema: 'nested property' }], idempotencyKey: 'synthetic' })
  expect(check({ name: 'root', children: [{ name: 1 }] })).toBe(false)
})
