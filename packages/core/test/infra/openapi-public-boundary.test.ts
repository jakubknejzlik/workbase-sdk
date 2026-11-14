import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import SwaggerParser from '@apidevtools/swagger-parser'
import { generate } from '../../src/openapi/generate'
import { publicSchema } from '../../src/public-schema'
import { cloneInstanceConfig } from '../../src/config'
import { defineConfig, defineEntity, bindSchemaLock } from '../../src/schema'
import { schemaLock } from '../../src/migrations/schema-lock'
import { KernelRegistry } from '../../src/kernel/registry'
import { workerAccessFixture } from '../fixtures/worker-access'
import access from '../fixtures/worker-access/access'
import worker from '../fixtures/worker-access/schema/worker'

// Count converter invocations while retaining the real Zod implementation.
vi.mock('zod', async original => {
  const actual = await original<typeof import('zod')>()
  return { ...actual, z: { ...actual.z, toJSONSchema: vi.fn(actual.z.toJSONSchema) } }
})

const hash = '0'.repeat(64), canary = 'synthetic-access-secret-at-least-32'
function base() {
  const config = cloneInstanceConfig(new KernelRegistry(workerAccessFixture()).config)
  config.commands = []
  config.effectiveAccess!.actions = []
  return config
}
const command = (name: string, input: z.ZodType) => ({ name, input, permission: { entity: 'worker', operation: 'update' }, additionalPermissions: [] }) as any
const registry = (commands: any[] = [], workflows: any[] = []) => ({ commands: new Map(commands.map(c => [c.name, c])), workflows: new Map(workflows.map(w => [w.name, w])) })
const document = (config: any, kernel: any) => JSON.parse(generate(config, kernel, hash))
const actionInput = (doc: any, entity: string, action: string) => {
  const ref = doc.paths[`/api/${entity}/{id}/actions/${action}`].post.requestBody.content['application/json'].schema.$ref
  return doc.components.schemas[ref.split('/').at(-1)]
}

it('keeps piped and wrapped command, workflow and action inputs within the public disclosure boundary', () => {
  const fields = [
    z.string().describe(canary).pipe(z.string().meta({ sensitive: true })),
    z.enum([canary, 'public']).pipe(z.string().meta({ sensitive: true }) as any),
    z.string().describe(canary).optional().pipe(z.string().meta({ sensitive: true }).optional()).optional(),
    z.object({ nested: z.string().describe(canary) }).pipe(z.object({ nested: z.string().meta({ sensitive: true }) })),
    z.string().describe(canary).pipe(z.string()),
    z.string().meta({ sensitive: true, description: canary }).pipe(z.string()),
    z.array(z.object({ [canary]: z.string() })).transform(() => 'public').pipe(z.string()),
    z.tuple([z.object({ [canary]: z.string() })]).transform(() => 'public').pipe(z.string()),
  ]
  for (const field of fields) {
    const input = z.object({ secret: field }), config = base()
    const cmd = command('probe', input), workflow = { name: 'probe', version: 1, input, steps: [] }
    config.commands = ['probe']
    config.effectiveAccess!.actions = [{ entity: 'worker', name: 'probe', command: 'probe', conditions: [], dependencies: [], source: 'probe' }]
    const kernel = registry([cmd], [workflow]), published = publicSchema(config, kernel)
    expect(JSON.stringify(published)).not.toContain(canary)
    const doc = document(config, kernel)
    expect(JSON.stringify(doc)).not.toContain(canary)
    expect(actionInput(doc, 'worker', 'probe').properties.secret).toEqual(doc['x-workbase-commands'][0].inputSchema.properties.secret)
  }
})
it('publishes only the /schema entity-to-role policy projection', () => {
  const config = base(), kernel = registry()
  config.policies = { worker: { staff: {} } } as any
  expect(document(config, kernel)['x-workbase-permissions'].entities).toEqual(publicSchema(config, kernel).policies)
  expect(document(config, kernel)['x-workbase-permissions'].entities).toEqual({ worker: { staff: true } })
})
function validatedActions() {
  const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' } as const
  const first = { ...command('first', z.object({ id: z.string(), first: z.string() })), permission: { entity: 'a', operation: 'update' }, plan: () => ({ rules: [], result: { status: 200, body: {} } }) }
  const second = { ...command('second', z.object({ id: z.string(), second: z.number() })), permission: { entity: 'a_b', operation: 'update' }, plan: first.plan }
  const config = defineConfig({ id: 'collision', commands: ['first', 'second'], plugins: [...workerAccessFixture().plugins!, { name: 'probe', version: '1.0.0', commands: [first, second] }], interactive: false, languages: ['en'], roles: ['admin', 'staff'], organizationOwnerRole: 'admin', entities: {
    worker,
    a: defineEntity({ fields: { name: { type: 'string', required: true } }, access: { admin: all, staff: 'deny' }, actions: { b_c: { command: 'first', available: [{ when: { name: { eq: 'private' } }, reason: `probe.${canary}` }] } } }),
    a_b: defineEntity({ fields: { name: { type: 'string', required: true } }, access: { admin: all, staff: 'deny' }, actions: { c: { command: 'second' } } }),
  }, access })
  return new KernelRegistry(bindSchemaLock(config, schemaLock(config)))
}
it('omits action condition inventories, command associations and private field flags after registration', () => {
  const kernel = validatedActions(), published = publicSchema(kernel.config, {}), doc = document(kernel.config, kernel)
  expect(JSON.stringify(published)).not.toContain(canary)
  expect(JSON.stringify(doc)).not.toContain(canary)
  expect(doc.components.schemas.Row_a).not.toHaveProperty('x-workbase-actions')
  expect(doc.components.schemas.Row_worker.properties.user['x-workbase-field']).toEqual(published.entities.worker.fields.user)
})
it('allocates distinct action tuple components and guards all other component namespaces', async () => {
  const kernel = validatedActions(), doc = document(kernel.config, kernel)
  expect(actionInput(doc, 'a', 'b_c').properties).toHaveProperty('first')
  expect(actionInput(doc, 'a_b', 'c').properties).toHaveProperty('second')
  expect(actionInput(doc, 'a', 'b_c')).not.toEqual(actionInput(doc, 'a_b', 'c'))
  await SwaggerParser.validate(structuredClone(doc))
  const duplicate = cloneInstanceConfig(kernel.config)
  duplicate.effectiveAccess!.actions.push(duplicate.effectiveAccess!.actions[0])
  expect(() => generate(duplicate, kernel, hash)).toThrow('component collision')
  for (const kind of ['command', 'workflow']) {
    const config = base(), names = ['a/b', 'a_b']
    config.commands = kind === 'command' ? names : []
    const input = z.object({ x: z.string() })
    const kernel = registry(kind === 'command' ? names.map(name => command(name, input)) : [], kind === 'workflow' ? names.map(name => ({ name, version: 1, input, steps: [] })) : [])
    // Either injectively encode names, or reject collisions; silent aliasing is forbidden.
    try {
      const result = document(config, kernel)
      const inputs = kind === 'command' ? result['x-workbase-commands'] : result['x-workbase-workflows']
      expect(inputs).toHaveLength(2)
      expect(Object.keys(result.components.schemas).filter(key => key.startsWith(kind === 'command' ? 'CommandInput_' : 'WorkflowInput_'))).toHaveLength(2)
    } catch (error) { expect(String(error)).toContain('collision') }
  }
})
it('sorts every generated query projection set including labelWhere property names', () => {
  const config = base()
  config.entities.worker.fields.manager = { type: 'ref', entity: 'users', required: false }
  config.entities.worker.fields.kind = { type: 'enum', values: ['z', 'a'], required: false }
  config.entities.worker.relations.manager_account = { entity: 'users', field: 'manager' }
  const reverse = cloneInstanceConfig(config)
  reverse.entities.worker.fields = Object.fromEntries(Object.entries(reverse.entities.worker.fields).reverse())
  reverse.entities.worker.relations = Object.fromEntries(Object.entries(reverse.entities.worker.relations).reverse())
  expect(generate(config, registry(), hash)).toBe(generate(reverse, registry(), hash))
  const doc = document(config, registry())
  expect(doc.components.schemas.Query_worker.properties.labelWhere.propertyNames.enum).toEqual(['manager', 'user'])
  expect(doc.components.schemas.Row_worker.properties.kind.anyOf[0].enum).toEqual(['z', 'a'])
})
it('never invokes default, prefault or catch factories and converts shared input schemas once', () => {
  let calls = 0
  const fail = () => { calls++; return canary }
  let tree: z.ZodType
  tree = z.object({ value: z.string().default(fail), children: z.array(z.lazy(() => tree)).optional() })
  const input = z.object({ tree: z.lazy(() => tree).optional(), name: z.string().default(fail), nested: z.array(z.string().prefault(fail)), caught: z.string().catch(fail) })
  const config = base()
  config.commands = ['probe']
  config.effectiveAccess!.actions = [{ entity: 'worker', name: 'probe', command: 'probe', conditions: [], dependencies: [], source: 'probe' }]
  const kernel = registry([command('probe', input)], [{ name: 'probe', version: 1, input, steps: [] }])
  vi.mocked(z.toJSONSchema).mockClear()
  const doc = document(config, kernel)
  expect(calls).toBe(0)
  expect(z.toJSONSchema).toHaveBeenCalledTimes(3 * Object.keys(config.entities).length + 1)
  expect(JSON.stringify(doc['x-workbase-commands'])).not.toContain(canary)
  expect(JSON.stringify(doc['x-workbase-commands'])).not.toContain('default')
  expect(input.parse({ nested: [], caught: 'valid' }).name).toBe(canary)
  expect(calls).toBe(1) // Generation did not remove the runtime default.
  const throwing = z.object({ name: z.string().default(() => { throw new Error('runtime environment not available at build time') }) })
  expect(() => generate(config, registry([command('probe', throwing)]), hash)).not.toThrow()
})
it('keeps the generator import graph free of runtime command handlers', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'openapi-imports-'))
  try {
    const meta = join(temp, 'imports.json')
    execFileSync('bun', ['build', 'packages/core/src/openapi/generate.ts', '--target=bun', '--packages=external', `--outfile=${join(temp, 'generate.js')}`, `--metafile=${meta}`], { cwd: resolve('.'), stdio: 'pipe' })
    const inputs = Object.keys(JSON.parse(await readFile(meta, 'utf8')).inputs)
    for (const file of ['worker-access-actions.ts', 'kernel/registry.ts', 'commands.ts', 'workflow-runtime.ts', 'crypto.ts', 'request-timing.ts']) expect(inputs.some(path => path.endsWith(`/${file}`)), file).toBe(false)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
