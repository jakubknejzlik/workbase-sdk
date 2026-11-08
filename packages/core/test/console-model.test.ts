import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { z } from 'zod'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { consoleUI } from '@workbasehq/plugins/console'
import { createApp } from '../src/app'
import { defineInstance, Fn, Q } from '../src/config'
import { defineCommand } from '../src/commands'
import { sha256 } from '../src/crypto'
import { initialSchema } from '../src/migrations/schema'
import { KernelRegistry } from '../src/kernel/registry'
import { tenancy } from '../src/kernel/adapters/tenancy'
import { publicConsoleResponse } from '../src/console'
import { consoleModel } from '../src/console-model'
import type { RuntimeOptions } from '../src/types'
import type { WorkflowDefinition } from '../src/execution/workflow'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import type { ConsoleEntityDisplay, ConsoleQuery } from '../src/console-contract'

const secret = 'SENSITIVE_CONSOLE_MODEL_CANARY'
const runtime = () => ({ DB: env.DB, AUDIT_KV: env.AUDIT_KV, IDENTITY: {
  baseURL: 'http://localhost', secret: 'synthetic-console-model-secret-at-least-32', localPassword: true,
} })
const plugins = [identity, localAuth, tenancy, legacyPermissions]
const empty = () => defineInstance({ id: 'previously_unknown_482', revision: 7, interactive: true, plugins, roles: ['owner', 'viewer'] })
function fixture() {
  return defineInstance({
    ...empty(), displayName: 'Neutral workspace', locale: 'cs', timeZone: 'Europe/Prague',
    enumLabels: { cs: { value_new: 'Nový', value_done: 'Hotový' } },
    entities: { specimens: {
      displayField: 'name',
      fields: {
        name: { type: 'string', required: true },
        note: { type: 'text' },
        enabled: { type: 'bool', required: true, default: false },
        count: { type: 'int', required: true, default: 0, min: 0 },
        ratio: { type: 'float', min: 0.25 },
        state: { type: 'enum', required: true, values: ['new', 'done'], default: 'new' },
        occurred_at: { type: 'datetime' },
        parent_id: { type: 'ref', entity: 'specimens' },
        lower: { type: 'int', required: true, default: 0 },
        upper: { type: 'int', required: true, default: 10 },
        secret: { type: 'string', sensitive: true, default: secret },
        nullable_default: { type: 'string', default: null },
        summary: { type: 'string', readOnly: true, default: 'server summary' },
      },
      relations: { parent: { entity: 'specimens', field: 'parent_id' }, children: { entity: 'specimens', field: 'parent_id', many: true } },
      checks: [{ left: 'lower', op: '<=', right: 'upper' }],
    } },
    permissions: { owner: { specimens: ['read', 'create', 'update', 'delete'] }, viewer: { specimens: ['read'] } },
    policies: { specimens: { owner: 'all', viewer: { where: {}, fields: ['name', 'state'] } } },
    ui: { defaultLanguage: 'cs', entities: { specimens: {
      list: { columns: ['name', 'state'], search: ['name'], views: [{ id: 'new_items', label: 'New items', where: { state: { eq: 'new' } } }] },
      form: { create: { fields: ['name'] }, edit: { fields: ['name', 'note'] } },
      sections: [{ id: 'main', label: 'Main fields', fields: ['name', 'note'] }],
    } } },
  })
}
let app: ReturnType<typeof createApp>
beforeEach(async () => { await reset() })
async function start(config = fixture(), options: RuntimeOptions = {}) {
  await env.DB.exec(initialSchema(config).replaceAll('\n', ' '))
  await new KernelRegistry(config, options).applyMigrations(env.DB)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','Neutral A'),('org-b','Neutral B')")
  for (const role of ['owner', 'viewer']) {
    await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,created_at) VALUES (?,?,?,?,?)').bind(role, `${role}@example.test`, 'synthetic', 'synthetic', 'now').run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, `${role}@example.test`, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
    await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-model-${role}`), role, new Date(Date.now() + 86400000).toISOString()).run()
  }
  app = createApp(config, runtime(), options)
}
function request(path = '/o/org-a/console-model', role = 'owner', method = 'GET', body?: unknown) {
  return app.request(`http://localhost${path}`, { method, headers: {
    Authorization: `Bearer synthetic-model-${role}`, 'Content-Type': 'application/json', 'X-Organization-Id': 'org-a',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function contract(role = 'owner') {
  const response = await request(undefined, role)
  expect(response.status).toBe(200)
  return await response.json() as ConsoleModelContract
}

it('empty config returns a usable versioned console model without a console plugin', async () => {
  await start(empty())
  const body = await contract()
  expect(body.contractVersion).toBe(1)
  expect(body.model).toMatchObject({ instance: 'previously_unknown_482', revision: 7, entities: {}, commands: [], workflows: [], locale: 'en', timeZone: 'UTC' })
  expect(body.capabilities.entities).toEqual({})
  expect(body.console).toBeNull()
})

it('an unfamiliar instance id with one entity supplies the generated read model and configured localization', async () => {
  await start()
  const body = await contract()
  expect(Object.keys(body.model.entities)).toEqual(['specimens'])
  expect(body.model).toMatchObject({ instance: 'previously_unknown_482', revision: 7, displayName: 'Neutral workspace', locale: 'cs', timeZone: 'Europe/Prague', enumLabels: { cs: { value_new: 'Nový' } } })
  expect(body.model.entities.specimens).toMatchObject({ displayField: 'name', listColumns: ['name', 'state'], listLimit: 30,
    routes: { list: '/o/$orgId/e/specimens', detail: '/o/$orgId/e/specimens/$id' },
    fields: { id: { type: 'string', readOnly: true }, version: { type: 'int', readOnly: true }, name: { operators: expect.arrayContaining(['eq', 'contains']) } },
    form: { create: { fields: ['name'] } }, sections: [{ id: 'main', label: 'Main fields', fields: ['name', 'note'] }],
    list: { views: [{ id: 'new_items', label: 'New items', where: { state: { eq: 'new' } } }] },
  })
  const text = JSON.stringify(body)
  expect(text).not.toMatch(/pluginConfig|backfillFrom|renameFrom|\$actor|predicate/)
})

it('required nullable default fields and validator constraints match actual create and partial update behavior', async () => {
  await start()
  const entity = (await contract()).model.entities.specimens
  expect(entity.fields.name).toMatchObject({ required: true, nullable: false })
  expect(entity.fields.note).toMatchObject({ required: false, nullable: true })
  expect(entity.fields.enabled.default).toBe(false)
  expect(entity.fields.count).toMatchObject({ default: 0, min: 0 })
  expect(entity.fields.nullable_default.default).toBeNull()
  const create = entity.writeSchema as any
  const update = entity.updateSchema as any
  expect(create.required).toEqual(['name'])
  expect(update.required ?? []).toEqual([])
  expect(create.additionalProperties).toBe(false)
  expect(create.properties.name).toMatchObject({ type: 'string', minLength: 1, maxLength: 2000 })
  expect(create.properties.note.anyOf).toContainEqual({ type: 'string', minLength: 1, maxLength: 100000 })
  expect(create.properties.count).toMatchObject({ type: 'integer', minimum: 0, default: 0 })
  expect(create.properties.ratio.anyOf).toContainEqual({ type: 'number', minimum: 0.25 })
  expect(create.properties.state.enum).toEqual(['new', 'done'])
  expect(create.properties.occurred_at.anyOf[0].format).toBe('date-time')
  for (const schema of [create, update]) expect(schema.properties).not.toHaveProperty('summary')
  expect(update.properties.count).not.toHaveProperty('default')
  for (const payload of [{}, { name: null }, { name: 'A', count: -1 }, { name: 'A', count: 1.5 }, { name: 'A', state: 'unknown' }]) {
    expect((await request('/api/specimens', 'owner', 'POST', payload)).status).toBe(400)
  }
  const created = await request('/api/specimens', 'owner', 'POST', { name: 'A', note: null })
  expect(created.status).toBe(201)
  const row = await created.json() as any
  expect(row).toMatchObject({ name: 'A', enabled: false, count: 0, state: 'new', note: null })
  const edited = await request(`/api/specimens/${row.id}`, 'owner', 'PATCH', { version: 1, count: 2 })
  expect(edited.status).toBe(200)
  expect(await edited.json()).toMatchObject({ name: 'A', count: 2, version: 2 })
})

it('one relation plus a cross-field constraint and planner indexes agree with the actual database', async () => {
  await start()
  const entity = (await contract()).model.entities.specimens
  expect(entity.relations.parent).toEqual({ entity: 'specimens', field: 'parent_id', cardinality: 'n:1' })
  expect(entity.relations.children).toEqual({ entity: 'specimens', field: 'parent_id', cardinality: '1:n', quantifiers: ['some', 'none'] })
  expect(entity.fields.parent_id).toMatchObject({ type: 'ref', entity: 'specimens', nullable: true })
  expect(entity.checks).toEqual([{ left: 'lower', op: '<=', right: 'upper' }])
  expect(entity.indexes).toEqual([
    { name: 'specimens_org_idx', fields: ['organization_id', 'id'], unique: false },
    { name: 'specimens_parent_id_idx', fields: ['organization_id', 'parent_id'], unique: false },
  ])
  for (const index of entity.indexes) {
    const columns = await env.DB.prepare(`PRAGMA index_info('${index.name}')`).all<{ name: string }>()
    expect(columns.results.map(column => column.name)).toEqual(index.fields)
  }
  const parent = await request('/api/specimens', 'owner', 'POST', { name: 'Parent' })
  const id = (await parent.json() as any).id
  expect((await request('/api/specimens', 'owner', 'POST', { name: 'Child', parent_id: id })).status).toBe(201)
  expect((await request('/api/specimens', 'owner', 'POST', { name: 'Bad range', lower: 20, upper: 10 })).status).toBe(409)
  expect((await request('/api/specimens', 'owner', 'POST', { name: 'Missing parent', parent_id: 'missing' })).status).toBe(409)
})

it('an unauthorized user gets no mutation or command grants and live membership changes take effect', async () => {
  await start()
  const body = await contract('viewer')
  expect(body.capabilities).toEqual(await (await request('/o/org-a/capabilities', 'viewer')).json())
  expect(body.capabilities.entities.specimens.operations).toEqual(['read'])
  expect(body.capabilities.entities.specimens.readable).toEqual(['id', 'name', 'state'])
  expect(body.capabilities.commands).toEqual([])
  const entity = body.model.entities.specimens
  expect(Object.keys(entity.fields)).toEqual(['id', 'name', 'state'])
  expect(entity.columns).toEqual(['name', 'state'])
  expect(entity.relations).toEqual({})
  expect(entity.checks).toEqual([])
  expect(entity.indexes).toEqual([])
  for (const schema of [entity.writeSchema, entity.updateSchema]) {
    expect(schema.properties).toEqual({})
    expect(schema.required ?? []).toEqual([])
  }
  expect((await request('/api/specimens', 'viewer', 'POST', { name: 'Forbidden' })).status).toBe(403)
  await env.DB.prepare("UPDATE memberships SET role='viewer' WHERE user_id='owner'").run()
  expect((await contract()).capabilities.entities.specimens.operations).toEqual(['read'])
  await env.DB.prepare("DELETE FROM memberships WHERE user_id='owner'").run()
  expect((await request()).status).toBe(403)
})

it('contract version field and private cache headers are present; anonymous and wrong-organization access fail', async () => {
  await start()
  const response = await request()
  expect((await response.json() as ConsoleModelContract).contractVersion).toBe(1)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.get('Vary')).toBe('Cookie, Authorization, X-Organization-Id')
  const anonymous = await app.request('http://localhost/o/org-a/console-model')
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers.get('Cache-Control')).toBe('private, no-store')
  expect((await request('/o/org-b/console-model')).status).toBe(403)
  expect((await request('/o/org-a/console-model/unknown')).status).toBe(404)
  expect(await publicConsoleResponse(new Request('http://localhost/o/org-a/console-model'), runtime())).toBeUndefined()
})

it('sensitive defaults never enter the model and the anonymous schema keeps its existing sanitization', async () => {
  await start()
  expect(JSON.stringify(await contract())).not.toContain(secret)
  const response = await app.request('http://localhost/schema')
  const schema = await response.json() as any
  expect(schema.entities.specimens.fields.count).not.toHaveProperty('default')
  expect(JSON.stringify(schema)).not.toContain(secret)
})

const sharedSecretInput = z.object({ password: z.string().default(secret).describe(secret) }).meta({ id: 'shared_secret_input' })
const referencedPassword = z.string().meta({ sensitive: true, id: 'referenced_password' })
const command = defineCommand({
  name: 'specimens/mark', permission: { entity: 'specimens', operation: 'update' },
  ui: { label: { en: 'Mark specimen', cs: 'Označit vzorek' } },
  input: z.object({
    id: z.string().meta({ referenceEntity: 'specimens' }),
    amount: z.number().int().min(1).max(5).default(1),
    mode: z.literal('mark'), default: z.string().optional(),
    preset: z.object({ const: z.string(), examples: z.array(z.string()), sensitive: z.boolean(), default: z.string() })
      .default({ const: 'literal data', examples: ['example data'], sensitive: true, default: 'default data' }),
    secret: z.object({ value: z.string().default(secret).describe(secret) }).meta({ sensitive: true }),
    parentDefault: z.object({ password: z.string().meta({ sensitive: true }) }).default({ password: secret }),
    parentConst: z.object({ password: z.string().meta({ sensitive: true }) }).meta({ const: { password: secret } }),
    arrayDefault: z.array(z.object({ password: z.string().meta({ sensitive: true }) })).default([{ password: secret }]),
    unionDefault: z.union([z.object({ password: z.string().meta({ sensitive: true }) }), z.null()]).default({ password: secret }),
    referencedDefault: z.object({ password: referencedPassword }).default({ password: secret }),
    referencedSecret: sharedSecretInput.meta({ sensitive: true }), shared: sharedSecretInput,
  }),
  plan: () => ({ rules: [], result: { status: 200, body: {} }, event: { entity: 'specimens', entityId: 'test', operation: 'mark' } }),
})
const workflow: WorkflowDefinition = {
  name: 'specimens/review', version: '1', input: command.input.extend({ mode: z.literal('review') }),
  steps: [{ id: 'mark', operation: command, sideEffect: false,
    policy: { maxAttempts: 1, backoffMs: 0, timeoutMs: 100, deadlineMs: 1000 }, run: async () => ({}) }],
}
it('commands and workflows preserve input constraints and localized labels only when the current user can execute them', async () => {
  const config = defineInstance({ ...fixture(), commands: [command.name] })
  await start(config, { commands: new Map([[command.name, command]]), workflows: new Map([[workflow.name, workflow]]) })
  const owner = await contract()
  expect(owner.model.commands).toHaveLength(1)
  expect(owner.model.commands[0]).toMatchObject({ name: command.name, ui: { label: { en: 'Mark specimen', cs: 'Označit vzorek' } },
    inputSchema: { properties: { id: { referenceEntity: 'specimens' }, amount: { type: 'integer', minimum: 1, maximum: 5, default: 1 }, mode: { const: 'mark' }, default: { type: 'string' } } },
  })
  expect(owner.model.workflows).toMatchObject([{ name: workflow.name, version: '1', inputSchema: { properties: { mode: { const: 'review' } } } }])
  // Literal data objects are not schema nodes, even when their keys match keywords.
  expect((owner.model.commands[0].inputSchema as any).properties.preset.default).toEqual({
    const: 'literal data', examples: ['example data'], sensitive: true, default: 'default data',
  })
  expect(JSON.stringify(owner)).not.toContain(secret)
  for (const schema of [owner.model.commands[0].inputSchema, owner.model.workflows[0].inputSchema]) {
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.parentDefault).not.toHaveProperty('default')
    expect(properties.parentConst).not.toHaveProperty('const')
    expect(properties.arrayDefault).not.toHaveProperty('default')
    expect(properties.unionDefault).not.toHaveProperty('default')
    expect(properties.referencedDefault).not.toHaveProperty('default')
  }
  const viewer = await contract('viewer')
  expect(viewer.model.commands).toEqual([])
  expect(viewer.model.workflows).toEqual([])
  expect(viewer.capabilities.commands).toEqual([])
  expect(viewer.capabilities.workflows[workflow.name]).toEqual([])
  expect((await request('/commands/specimens/mark', 'viewer', 'POST', { id: 'anything' })).status).toBe(403)
})

it('recursive command and workflow root references cannot carry sensitive descendant defaults', async () => {
  const input = z.object({
    password: z.string().meta({ sensitive: true }),
    get child() { return input.optional().meta({ default: { password: secret }, const: { password: secret } }) },
  })
  const recursiveCommand = defineCommand({ name: command.name, permission: command.permission, input,
    plan: () => ({ rules: [], result: { status: 200, body: {} }, event: { entity: 'specimens', entityId: 'test', operation: 'mark' } }),
  })
  const recursiveWorkflow = { ...workflow, input }
  await start(defineInstance({ ...fixture(), commands: [command.name] }), {
    commands: new Map([[command.name, recursiveCommand]]), workflows: new Map([[workflow.name, recursiveWorkflow]]),
  })
  const body = await contract()
  for (const schema of [body.model.commands[0].inputSchema, body.model.workflows[0].inputSchema]) {
    expect((schema.properties as any).child).toEqual({ $ref: '#' })
  }
  expect(JSON.stringify(body)).not.toContain(secret)
})

it('the existing console provider supplies its scoped registry without a core dependency on its implementation', async () => {
  const config = fixture()
  await start(defineInstance({ ...config, plugins: [...plugins, consoleUI()] }))
  const body = await contract('viewer')
  expect(body.console?.navigation).toContainEqual(expect.objectContaining({ entity: 'specimens' }))
  expect(body.console?.entities.specimens.form).toEqual({})
  expect(body.console?.entities.specimens.sections).toEqual([{ id: 'main', label: 'Main fields', fields: ['name'] }])
})

// Raw JSON Schema metadata exercises reference spellings independently of Zod's emitter.
function referenceCanaries(canary: string) {
  return z.object({}).meta({
    $id: 'https://local.invalid/schema',
    properties: {
      anchored: { type: 'object', properties: { password: { $ref: '#private%5Fanchor' } }, default: { password: canary }, const: { password: canary }, description: canary },
      encoded: { type: 'object', properties: { password: { $ref: '#/%24defs/private%7E1value' } }, default: { password: canary }, const: { password: canary } },
      secretAlias: { $ref: '#/$defs/alias', sensitive: true },
      publicAlias: { $ref: '#/$defs/alias', description: canary },
      unresolved: { $ref: '#missing', default: canary, const: canary, enum: [canary], description: canary },
      external: { $ref: 'https://unavailable.invalid/schema', default: canary, description: canary },
      malformed: { $ref: '#/%ZZ', default: canary, description: canary },
      opaque: { type: 'string', unrecognized: { default: canary }, default: canary, description: canary },
      dynamic: { $dynamicRef: '#private_dynamic', default: canary, description: canary },
      ambiguous: { $ref: '#ambiguous', default: canary, description: canary },
      absolute: { $ref: 'https://local.invalid/schema#/$defs/public', default: 'safe absolute default' },
      privatePattern: { type: 'string', sensitive: true, pattern: canary },
      unknownFormat: { type: 'string', format: canary, default: canary },
      deniedReference: { type: 'string', referenceEntity: 'vaults', default: canary, description: canary, 'x-ui': { section: canary } },
      safe: { $ref: '#/$defs/public', default: 'safe default', description: 'Safe description', examples: [canary], 'x-ui': { kind: 'input', unrecognized: canary } },
    },
    $defs: {
      anchored: { $anchor: 'private_anchor', type: 'string', sensitive: true, default: canary, description: canary },
      'private/value': { type: 'string', sensitive: true, default: canary, description: canary },
      alias: { $ref: '#/$defs/alias_target', description: canary },
      alias_target: { type: 'string', default: canary, description: canary },
      dynamic_target: { $dynamicAnchor: 'private_dynamic', type: 'string', default: canary, description: canary },
      ambiguous_a: { $anchor: 'ambiguous', type: 'string', default: canary, description: canary },
      ambiguous_b: { $anchor: 'ambiguous', type: 'string', default: canary, description: canary },
      public: { type: 'string', enum: ['safe choice'] },
    },
  })
}

it.each([false, true])('whole response excludes private canaries with console provider=%s', async provider => {
  const canary = 'W27_WHOLE_RESPONSE_PRIVATE_84621'
  const base = fixture()
  const input = referenceCanaries(canary)
  const privateCommand = { ...command, input }
  const privateWorkflow = { ...workflow, input }
  const deniedQueries = [
    { labelWhere: { parent_id: { contains: canary } } },
    { search: { text: canary, fields: ['parent_id'] } },
    { orderBy: [{ field: 'parent_id', dir: 'asc' as const, label: true }] },
    { labels: ['parent_id'] },
    { where: { parent_id: { eq: canary } } },
    { orderBy: [{ field: 'parent_id', dir: 'asc' as const }] },
  ]
  const config = defineInstance({
    ...base, commands: [command.name], plugins: provider ? [...plugins, consoleUI(), {
      name: 'private-display', version: '1', requires: { console: '^1' },
      contributes: { console: {
        pages: [{ id: 'private_dependencies', path: '/private-dependencies', label: canary,
          widgets: deniedQueries.map((dependencies, index) => ({ id: `dependency_${index}`, kind: 'table' as const, label: canary,
            columns: ['name'], query: { entity: 'specimens', select: ['id', 'name'], limit: 1, ...dependencies } })) }],
        entities: { specimens: {
          fields: { secret: { section: canary }, count: { signedBy: { field: 'state', negativeValue: canary } } },
          list: { views: [{ id: 'private_overlay', label: canary, where: { state: { eq: canary } } }] },
        } } } },
    }] : plugins,
    enumLabels: { cs: { [`value_${canary}`]: canary } },
    entities: {
      specimens: { ...base.entities.specimens, relations: { parent: { entity: 'vaults', field: 'parent_id' } }, displayField: 'state', fields: {
        ...base.entities.specimens.fields,
        state: { type: 'enum', required: true, sensitive: true, values: [canary], default: canary, ui: { section: canary } },
        secret: { type: 'string', sensitive: true, default: canary, ui: { section: canary } },
        count: { type: 'int', ui: { signedBy: { field: 'state', negativeValue: canary } } },
        parent_id: { type: 'ref', entity: 'vaults' },
      } },
      vaults: { displayField: 'private_hint', fields: { private_hint: { type: 'enum', values: [canary], default: canary, ui: { section: canary } } } },
    },
    permissions: { owner: { specimens: ['read', 'create', 'update'], vaults: ['read'] }, viewer: { specimens: ['read', 'create', 'update'] } },
    policies: { specimens: { owner: 'all', viewer: { where: {}, fields: ['name', 'count', 'parent_id'] } }, vaults: { owner: 'all', viewer: 'all' } },
    ui: { entities: {
      specimens: {
        list: { columns: ['name', 'state'], filter: { state: 'enum' }, sort: { state: false },
          views: [{ id: 'private', label: canary, where: { or: [{ name: { eq: 'public' } }, { state: { eq: canary } }] } }] },
        sections: [{ id: 'private_section', label: canary, fields: ['state'] }],
        detail: { groups: [{ id: 'private_group', label: canary, help: canary, fields: [{ field: 'state', help: canary }] }],
          summary: [{ field: 'name', when: { field: 'state', eq: canary }, help: canary }] },
      },
      vaults: { sections: [{ id: 'vault', label: canary, fields: ['private_hint'] }] },
    }, navigation: { groups: [{ id: 'private_group', label: canary }], items: [
      { id: 'private_view', entity: 'specimens', view: 'private', label: canary, group: 'private_group' },
      { id: 'owner_view', entity: 'specimens', roles: ['owner'], label: canary, group: 'private_group' },
      { id: 'vaults', entity: 'vaults', label: canary },
    ] } },
  })
  await start(config, { commands: new Map([[command.name, privateCommand]]), workflows: new Map([[workflow.name, privateWorkflow]]) })
  const body = await contract('viewer')
  expect(body.model.commands).toHaveLength(1)
  expect(body.model.workflows).toHaveLength(1)
  expect(body.capabilities.entities.specimens.operations).toEqual(['read', 'create', 'update'])
  for (const schema of [body.model.commands[0].inputSchema, body.model.workflows[0].inputSchema]) {
    const properties = schema.properties as any
    expect(properties.safe).toMatchObject({ $ref: '#/$defs/public' })
    for (const key of ['anchored', 'encoded', 'secretAlias', 'publicAlias', 'unresolved', 'external', 'malformed', 'opaque', 'dynamic', 'ambiguous', 'deniedReference', 'safe', 'absolute', 'privatePattern', 'unknownFormat']) {
      for (const literal of ['default', 'const', 'enum', 'description', 'examples', 'pattern']) expect(properties[key], key).not.toHaveProperty(literal)
    }
    expect(properties.unknownFormat).not.toHaveProperty('format')
    expect(properties.deniedReference).not.toHaveProperty('referenceEntity')
    expect(properties.deniedReference).not.toHaveProperty('x-ui')
    expect(properties.opaque).not.toHaveProperty('unrecognized')
    expect(properties.safe).not.toHaveProperty('examples')
    for (const key of ['anchored', 'private/value', 'alias', 'alias_target', 'dynamic_target', 'ambiguous_a', 'ambiguous_b']) expect((schema.$defs as any)[key], key).not.toHaveProperty('description')
  }
  for (const schema of [body.model.entities.specimens.writeSchema, body.model.entities.specimens.updateSchema]) {
    expect(schema.properties).toHaveProperty('state')
    expect(JSON.stringify((schema.properties as any).state)).not.toContain(canary)
  }
  expect(JSON.stringify(body)).not.toContain(canary)
  expect(body.model.entities).not.toHaveProperty('vaults')
  const entity = body.model.entities.specimens
  expect(Object.keys(entity.fields)).toEqual(['id', 'name', 'count'])
  expect(entity).not.toHaveProperty('displayField')
  expect(entity.fields.count.ui).not.toHaveProperty('signedBy')
  expect(entity.listColumns).toEqual(['name'])
  expect(entity.list?.views).toEqual([])
  expect(body.model.enumLabels).toEqual({})
  expect(body.model.ui?.navigation?.items).toEqual([])
  expect(body.console === null).toBe(!provider)
  if (provider) {
    expect(body.console?.pages.some(page => page.id === 'private_dependencies')).toBe(false)
    expect(body.console?.entities).not.toHaveProperty('vaults')
    expect(body.console?.entities.specimens.fields).not.toHaveProperty('secret')
    expect(body.console?.entities.specimens.list?.views).toEqual([])
  }
  expect((await app.request('http://localhost/o/org-a/console-model')).status).toBe(401)
  expect((await request('/o/org-b/console-model', 'viewer')).status).toBe(403)
})

it('live provider field masks prune label dependencies and references throughout presentation metadata', async () => {
  const base = fixture()
  const config = defineInstance({
    ...base,
    plugins: [...plugins, {
      name: 'narrow-fields', version: '1',
      fieldMask: () => ['id', 'name', 'summary', 'parent_id', 'occurred_at', 'count'],
    }],
    entities: { specimens: { ...base.entities.specimens, displayField: 'summary', label: 'secret' } },
    ui: { entities: { specimens: {
      views: [{ kind: 'calendar', startField: 'occurred_at', titleField: 'note' }],
      list: { columns: ['name', 'note', 'ancestor'], search: ['name', 'note'],
        relatedColumns: { ancestor: { via: 'parent_id', field: 'parent_id' } },
        sort: { count: { fields: ['count', 'lower'] } }, defaultSort: { key: 'count', direction: 'asc' },
        filter: { name: 'text', note: 'text' },
        views: [{ id: 'nested_private', label: 'Private', where: { parent: { secret: { eq: secret } } } }],
      },
      detail: {
        fields: ['name', 'note'], metrics: [{ field: 'count', unitField: 'state' }],
        lists: { notes: { entity: 'specimens', label: 'Notes', bind: { field: 'parent_id', record: 'id' }, columns: ['name', 'note'], create: true } },
        relations: { parent: { columns: ['name', 'note'], defaultSort: { key: 'note', direction: 'asc' } } },
        sections: [{ row: ['children', 'notes'] }],
      },
    } } },
  })
  await start(config)
  const body = await contract('viewer')
  const entity = body.model.entities.specimens
  // The configured viewer mask and the provider mask intersect; neither is sufficient alone.
  expect(Object.keys(entity.fields)).toEqual(['id', 'name'])
  expect(entity).not.toHaveProperty('displayField')
  expect(entity).not.toHaveProperty('labelDependencies')
  expect(entity.listColumns).toEqual(['name'])
  expect(entity.list).toEqual({ columns: ['name'], relatedColumns: {}, search: ['name'], sort: {}, filter: { name: 'text' }, views: [] })
  expect(entity.views).toEqual([])
  expect(entity.detail).toEqual({ fields: ['name'], metrics: [], lists: {}, relations: {}, sections: [] })
  expect(entity.relations).toEqual({})
  expect(JSON.stringify(body)).not.toContain(secret)

  // Expand the live role while retaining the provider mask: safe references survive.
  await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id='viewer'").run()
  const expanded = (await contract('viewer')).model.entities.specimens
  expect(Object.keys(expanded.fields)).toEqual(['id', 'name', 'count', 'occurred_at', 'parent_id'])
  expect(expanded).not.toHaveProperty('displayField')
  expect(expanded).not.toHaveProperty('labelDependencies')
  expect(expanded.listColumns).toEqual(['name', 'ancestor'])
  expect(expanded.detail?.lists?.notes).toEqual({ entity: 'specimens', label: 'Notes', bind: { field: 'parent_id', record: 'id' }, columns: ['name'], create: true })
  expect(expanded.detail?.relations?.parent).toEqual({ columns: ['name'] })
  expect(expanded.detail?.sections).toEqual([{ row: ['children', 'notes'] }])
  expect(expanded.relations).toHaveProperty('parent')
})

it.each(['create', 'update'] as const)('%s input metadata requires its own operation and writable field grants', async operation => {
  const base = fixture()
  await start(defineInstance({ ...base, permissions: { ...base.permissions, owner: { specimens: [operation] } } }))
  const entity = (await contract()).model.entities.specimens
  expect(entity.fields).toEqual({})
  expect(entity.columns).toEqual([])
  const allowed = operation === 'create' ? entity.writeSchema : entity.updateSchema
  const denied = operation === 'create' ? entity.updateSchema : entity.writeSchema
  expect(allowed.properties).toHaveProperty('name')
  expect(allowed.properties).not.toHaveProperty('summary')
  expect(allowed.required ?? []).toEqual(operation === 'create' ? ['name'] : [])
  expect(denied.properties).toEqual({})
  expect(denied.required ?? []).toEqual([])
  expect(JSON.stringify(entity)).not.toContain(secret)
})

it('core sanitizes raw provider pages, widget predicates and role/grant navigation before returning the registry', async () => {
  const canary = 'W27_RAW_PROVIDER_PRIVATE_92853'
  const provider = consoleUI()
  await start(defineInstance({ ...fixture(), plugins: [...plugins, {
    ...provider,
    consoleRegistry(config, scope) {
      const registry = provider.consoleRegistry!(config, scope)
      return { ...registry,
        entities: { ...registry.entities, specimens: { ...registry.entities.specimens, unknownAnnotation: canary,
          fields: { ...registry.entities.specimens.fields, name: { unknownAnnotation: canary, kind: 'input' as const } },
          detail: { fields: ['name'], unknownAnnotation: canary },
        } },
        modelUi: { ...registry.modelUi, unknownAnnotation: canary },
        pages: [...registry.pages,
          { id: 'private_widgets', path: '/private', label: canary, widgets: [
            { id: 'private_filter', kind: 'table', label: canary, columns: ['name'], query: { entity: 'specimens', select: ['id', 'name'], limit: 1, where: { secret: { eq: canary } } } },
            { id: 'private_sum', kind: 'stat', label: canary, query: { entity: 'specimens' }, aggregate: { fn: 'sum', field: 'count' } },
          ] },
          { id: 'denied_page', path: '/denied', label: canary, renderer: 'private', grant: 'organizations.update' },
          { id: 'raw_label_dependencies', path: '/raw-labels', label: 'Raw labels', widgets: [
            { id: 'raw_label_where', kind: 'table', label: 'Raw label filter', columns: ['name'], query: { entity: 'specimens', select: ['id', 'name'], limit: 1, labelWhere: { parent_id: { contains: canary } } } },
            { id: 'raw_label_search', kind: 'table', label: 'Raw search', columns: ['name'], query: { entity: 'specimens', select: ['id', 'name'], limit: 1, search: { text: canary, fields: ['parent_id'] } } },
            { id: 'raw_label_order', kind: 'table', label: canary, columns: ['name'], query: { entity: 'specimens', select: ['id', 'name'], limit: 1, orderBy: [{ field: 'parent_id', dir: 'asc', label: true }] } },
          ] },
          { id: 'safe_widgets', path: '/safe', label: 'Safe page', grant: { entity: 'specimens', unknownAnnotation: canary }, unknownAnnotation: canary, widgets: [
            { id: 'safe_list', kind: 'list', label: 'Names', unknownAnnotation: canary, field: 'name', query: { entity: 'specimens', select: ['id', 'name'], limit: 1, where: { state: { eq: 'new' } } } },
          ], sections: [{ row: ['safe_list'] }] },
        ],
        navigation: [...registry.navigation,
          { id: 'private_nav', placement: 'sidebar', label: canary, page: 'private_widgets' },
          { id: 'owner_nav', placement: 'sidebar', label: canary, page: 'core.overview', roles: ['owner'] },
          { id: 'grant_nav', placement: 'sidebar', label: canary, page: 'core.overview', grant: 'organizations.update' },
        ],
      }
    },
  }] }))
  const body = await contract('viewer')
  expect(JSON.stringify(body)).not.toContain(canary)
  expect(body.console?.pages.some(page => page.id === 'private_widgets' || page.id === 'denied_page' || page.id === 'raw_label_dependencies')).toBe(false)
  expect(body.console?.pages.find(page => page.id === 'safe_widgets')).toMatchObject({ widgets: [{ id: 'safe_list' }], sections: [{ row: ['safe_list'] }] })
})

it('commandsOnly entities advertise no CRUD mutations even for an owner', async () => {
  const config = fixture()
  await start(defineInstance({ ...config, entities: { specimens: { ...config.entities.specimens, commandsOnly: true } } }))
  const body = await contract()
  expect(body.model.entities.specimens.commandsOnly).toBe(true)
  expect(body.capabilities.entities.specimens.operations).toEqual(['read'])
  expect((await request('/api/specimens', 'owner', 'POST', { name: 'Forbidden CRUD' })).status).toBe(405)
})

it.each([false, true])('shared schema reachability is cycle-safe and linear with sensitive leaf=%s', async sensitive => {
  const defs: Record<string, unknown> = { leaf: { type: 'string', sensitive, default: secret } }
  for (let level = 99; level >= 0; level--) {
    const target = level === 99 ? 'leaf' : `level_${level + 1}`
    defs[`level_${level}`] = { type: 'object', properties: { left: { $ref: `#/$defs/${target}` }, right: { $ref: `#/$defs/${target}` } } }
  }
  // A back edge checks that shared graph traversal terminates without caching a false result in a cycle.
  defs.cycle = { anyOf: [{ $ref: '#/$defs/cycle' }, { $ref: '#/$defs/level_0' }], default: secret }
  const input = z.object({}).meta({ properties: { graph: { $ref: '#/$defs/cycle', default: secret } }, $defs: defs })
  const kernel = new KernelRegistry(defineInstance({ ...fixture(), commands: [command.name] }), { commands: new Map([[command.name, { ...command, input }]]) })
  const started = performance.now()
  const body = consoleModel(kernel, { organizationId: 'org-a', actor: { type: 'user', id: 'owner' }, role: 'owner', correlationId: 'perf' })
  // Workers update their wall clock on I/O; sample after a timer so synchronous
  // exponential work cannot pass with a frozen performance.now().
  await new Promise(resolve => setTimeout(resolve, 0))
  const elapsed = performance.now() - started
  expect(elapsed).toBeLessThan(200)
  if (sensitive) expect(JSON.stringify(body)).not.toContain(secret)
  else expect((body.model.commands[0].inputSchema.properties as any).graph.default).toBe(secret)
})

it.each([false, true])('readable sensitive presentation literals fail closed for owners and field-authorized viewers, provider=%s', async provider => {
  const canary = 'W27_READABLE_SENSITIVE_PRESENTATION_38917'
  const base = fixture()
  const unsafeWhere = [
    { state: { eq: canary } },
    { and: [{ name: { eq: 'public' } }, { state: { in: [canary] } }] },
    { or: [{ name: { eq: 'public' } }, { not: { state: { eq: canary } } }] },
    { parent: { state: { eq: canary } } },
    { children: { some: { state: { eq: canary } } } },
    { children: { none: { state: { eq: canary } } } },
  ]
  const display: ConsoleEntityDisplay = {
    list: { search: ['name', 'secret'], filter: { state: 'enum', name: 'text' },
      sort: { state: { fields: ['state'] }, name: { fields: ['name', 'state'] }, count: { fields: ['count'] } },
      defaultSort: { key: 'state', direction: 'asc' }, views: [
      ...unsafeWhere.map((where, index) => ({ id: `private_${index}`, label: 'Private view', where })),
      { id: 'public', label: 'Public view', where: { name: { eq: 'public' } } },
    ] },
    detail: { relations: { children: { columns: ['name'], defaultSort: { key: 'state', direction: 'asc' } } },
      summary: [{ field: 'name', when: { field: 'state', eq: canary } }], groups: [
      { id: 'private', label: 'Private group', fields: [{ field: 'count', when: { field: 'state', eq: canary } }] },
      { id: 'public', label: 'Public group', fields: [{ field: 'ratio', when: { field: 'enabled', eq: false } }] },
    ] },
  }
  const dependencies: Partial<ConsoleQuery>[] = [
    ...unsafeWhere.map(where => ({ where })),
    { search: { text: canary, fields: ['name', 'state'] } },
    { search: { text: canary, fields: ['parent_id'] } },
    { labelWhere: { parent_id: { contains: canary } } },
    { orderBy: [{ field: 'state', dir: 'asc' }] },
    { orderBy: [{ field: 'parent_id', dir: 'asc', label: true }] },
    { labels: ['parent_id'] },
  ]
  await start(defineInstance({ ...base,
    plugins: [...plugins, ...(provider ? [consoleUI(), {
      name: 'sensitive-presentation', version: '1', requires: { console: '^1' as const },
      contributes: { console: {
        entities: { specimens: { ...display, fields: { count: { signedBy: { field: 'state', negativeValue: canary } } } } },
        pages: [{ id: 'sensitive_widgets', path: '/sensitive-widgets', label: 'Widgets', widgets: [
          ...dependencies.map((dependency, index) => ({ id: `private_${index}`, label: 'Private widget', kind: 'table' as const,
            columns: ['name'], query: { entity: 'specimens', select: ['id', 'name'], limit: 1, ...dependency } })),
          { id: 'public', label: 'Public widget', kind: 'table' as const, columns: ['name'],
            query: { entity: 'specimens', select: ['id', 'name'], limit: 1, search: { text: 'public', fields: ['name'] }, orderBy: [{ field: 'name', dir: 'asc' as const }] } },
        ] }],
      } },
    }] : [])],
    entities: { specimens: { ...base.entities.specimens, displayField: 'state', fields: { ...base.entities.specimens.fields,
      state: { type: 'enum', sensitive: true, required: true, values: [canary], default: canary },
      count: { type: 'int', ui: { signedBy: { field: 'state', negativeValue: canary } } },
      ratio: { type: 'float', ui: { signedBy: { field: 'name', negativeValue: 'public' } } },
    } } },
    permissions: { owner: { specimens: ['read', 'create', 'update'] }, viewer: { specimens: ['read', 'create', 'update'] } },
    policies: { specimens: { owner: 'all', viewer: { where: {}, fields: ['name', 'state', 'count', 'ratio', 'enabled', 'parent_id', 'secret'] } } },
    ui: { entities: { specimens: display } },
  }))
  for (const role of ['owner', 'viewer']) {
    const body = await contract(role)
    expect(body.capabilities.entities.specimens.readable).toContain('state')
    expect(body.capabilities.entities.specimens.readable).toContain('secret')
    const entity = body.model.entities.specimens
    expect(entity.fields.state).toMatchObject({ sensitive: true })
    expect(entity.fields.state).not.toHaveProperty('values')
    expect(entity.fields.count.ui).not.toHaveProperty('signedBy')
    expect(entity.fields.ratio.ui?.signedBy).toEqual({ field: 'name', negativeValue: 'public' })
    for (const schema of [entity.writeSchema, entity.updateSchema]) expect(schema.properties).toHaveProperty('state')
    const displays = [entity, body.model.ui?.entities?.specimens,
      ...(provider ? [body.console?.entities.specimens, body.console?.modelUi?.entities?.specimens] : [])]
    for (const hints of displays) {
      expect(hints?.list?.views?.map(view => view.id)).toEqual(['public'])
      expect(hints?.list?.search).toEqual(['name'])
      expect(hints?.list?.filter).toEqual({ name: 'text' })
      expect(hints?.list?.sort).toEqual({ count: { fields: ['count'] } })
      expect(hints?.list).not.toHaveProperty('defaultSort')
      expect(hints?.detail?.summary).toEqual([])
      expect(hints?.detail?.relations?.children).toEqual({ columns: ['name'] })
      expect(hints?.detail?.groups?.map(group => group.id)).toEqual(['public'])
      expect(hints?.detail?.groups?.[0].fields).toEqual([{ field: 'ratio', when: { field: 'enabled', eq: false } }])
    }
    expect(body.console === null).toBe(!provider)
    if (provider) {
      expect(body.console?.entities.specimens.fields?.count).not.toHaveProperty('signedBy')
      expect(body.console?.pages.find(page => page.id === 'sensitive_widgets')?.widgets?.map(widget => widget.id)).toEqual(['public'])
    }
    expect(JSON.stringify(body), role).not.toContain(canary)
  }
})

it.each([false, true])('write literals require readable fields and retain sensitivity through conversion, provider=%s', async provider => {
  const canary = 'W27_PRIVATE_ENUM_CHOICES_75291'
  const base = fixture()
  await start(defineInstance({ ...base,
    plugins: [...plugins, ...(provider ? [consoleUI()] : []), { name: 'read-name-only', version: '1', fieldMask: (_entity, scope) => scope.role === 'owner' ? ['id', 'name', 'secret_choice'] : ['id', 'name'] }],
    permissions: { ...base.permissions, viewer: { specimens: ['read', 'create', 'update'] } },
    entities: { specimens: { ...base.entities.specimens, fields: { ...base.entities.specimens.fields,
      state: { type: 'enum', required: true, values: [canary], default: canary },
      secret_choice: { type: 'enum', sensitive: true, values: [canary], default: canary },
    } } },
  }))
  const body = await contract('viewer')
  expect(body.capabilities.entities.specimens.readable).toEqual(['id', 'name'])
  expect(Object.keys(body.model.entities.specimens.fields)).toEqual(['id', 'name'])
  for (const schema of [body.model.entities.specimens.writeSchema, body.model.entities.specimens.updateSchema]) {
    for (const field of ['state', 'secret_choice']) {
      expect(schema.properties).toHaveProperty(field)
      expect(JSON.stringify((schema.properties as any)[field])).not.toContain(canary)
    }
    expect((schema.properties as any).secret_choice.sensitive).toBe(true)
  }
  expect(JSON.stringify(body)).not.toContain(canary)
  await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id='viewer'").run()
  // Even a readable sensitive enum must never disclose its validation literals.
  const owner = await contract('viewer')
  expect(owner.model.entities.specimens.fields.secret_choice).toMatchObject({ sensitive: true })
  expect(owner.model.entities.specimens.fields.secret_choice).not.toHaveProperty('values')
  expect(JSON.stringify(owner)).not.toContain(canary)
})

it.each(['entity', 'id', 'display', 'dependency', 'sensitive_hop', 'sensitive_display', 'sensitive_dependency', 'allowed'] as const)('every provider label/search/order dependency requires target %s access', async denial => {
  const canary = 'W27_LABEL_FILTER_CANARY_71338'
  const base = fixture()
  const queries = [
    { labelWhere: { parent_id: { contains: canary } } },
    { search: { text: canary, fields: ['parent_id'] } },
    { orderBy: [{ field: 'parent_id', dir: 'asc' as const, label: true }] },
    { labels: ['parent_id'] },
    ...(['entity', 'id', 'sensitive_hop', 'allowed'].includes(denial) ? [
      { where: { parent_id: { eq: canary } } },
      { orderBy: [{ field: 'parent_id', dir: 'asc' as const }] },
    ] : []),
  ]
  await start(defineInstance({ ...base,
    plugins: [...plugins, consoleUI(), { name: 'target-display', version: '1', requires: { console: '^1' },
      fieldMask(entity) { return entity === 'vaults' ? denial === 'id' ? ['name'] : denial === 'display' ? ['id'] : denial === 'sensitive_dependency' ? ['id', 'name', 'private_value'] : ['id', 'name'] : ['id', 'name', 'parent_id'] },
      contributes: { console: { pages: [{ id: 'dependencies', path: '/dependencies', label: 'Dependencies',
        widgets: queries.map((dependencies, index) => ({ id: `dependency_${index}`, label: 'Dependent widget', kind: 'table' as const, columns: ['name'],
          query: { entity: 'specimens', select: ['id', 'name'], limit: 1, ...dependencies } })) }] } },
    }],
    entities: {
      specimens: { ...base.entities.specimens, relations: { parent: { entity: 'vaults', field: 'parent_id' } },
        fields: { ...base.entities.specimens.fields, parent_id: { type: 'ref', entity: 'vaults', sensitive: denial === 'sensitive_hop' } } },
      vaults: { displayField: 'name', ...(['dependency', 'sensitive_dependency'].includes(denial) ? { label: 'private_value' } : {}),
        fields: { name: { type: 'string', sensitive: denial === 'sensitive_display', ...(['dependency', 'sensitive_dependency'].includes(denial) ? { readOnly: true } : {}) },
          private_value: { type: 'string', sensitive: denial === 'sensitive_dependency' } } },
    },
    permissions: { owner: { specimens: ['read'], vaults: ['read'] }, viewer: { specimens: ['read'], ...(denial === 'entity' ? {} : { vaults: ['read'] }) } },
    policies: { specimens: { owner: 'all', viewer: { where: {}, fields: ['name', 'parent_id'] } }, vaults: { owner: 'all', viewer: { where: {}, fields: ['name', 'private_value'] } } },
  }))
  const body = await contract('viewer')
  if (denial.startsWith('sensitive_')) {
    expect(body.capabilities.entities.specimens.readable).toContain('parent_id')
    expect(body.model.entities.vaults.fields).toHaveProperty('name')
    if (denial === 'sensitive_dependency') expect(body.model.entities.vaults.fields).toHaveProperty('private_value')
  }
  const page = body.console?.pages.find(page => page.id === 'dependencies')
  if (denial === 'allowed') {
    expect(page?.widgets?.map(widget => widget.id)).toEqual(['dependency_0', 'dependency_1', 'dependency_2', 'dependency_3', 'dependency_4', 'dependency_5'])
    expect(JSON.stringify(body)).toContain(canary)
  } else {
    expect(page).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(canary)
  }
})

it('fully resolved graphs redact private anchors/pointers/aliases while retaining public literals', async () => {
  const input = z.object({}).meta({
    $id: 'https://local.invalid/public',
    properties: {
      anchor: { $ref: '#public', default: 'public default', description: 'Public input', 'x-ui': { kind: 'input' } },
      pointer: { $ref: '#/%24defs/public', const: 'public constant', pattern: '^public' },
      absolute: { $ref: 'https://local.invalid/public#public', enum: ['public choice'] },
      privateAnchor: { type: 'object', properties: { password: { $ref: '#private' } }, default: { password: secret } },
      privatePointer: { type: 'object', properties: { password: { $ref: '#/%24defs/private%7E1target' } }, const: { password: secret } },
      privateContext: { $ref: '#/$defs/privateAlias', sensitive: true },
      publicAlias: { $ref: '#/$defs/privateAlias', description: secret },
    },
    $defs: {
      public: { $anchor: 'public', type: 'string', description: 'Public definition' },
      private: { $anchor: 'private', type: 'string', sensitive: true, default: secret, description: secret },
      'private/target': { type: 'string', sensitive: true, default: secret, description: secret },
      privateAlias: { $ref: '#/$defs/aliasTarget', description: secret },
      aliasTarget: { type: 'string', default: secret, description: secret },
    },
  })
  await start(defineInstance({ ...fixture(), commands: [command.name] }), {
    commands: new Map([[command.name, { ...command, input }]]), workflows: new Map([[workflow.name, { ...workflow, input }]]),
  })
  const body = await contract()
  for (const schema of [body.model.commands[0].inputSchema, body.model.workflows[0].inputSchema]) {
    expect(schema.properties).toMatchObject({
      anchor: { default: 'public default', description: 'Public input', 'x-ui': { kind: 'input' } },
      pointer: { const: 'public constant', pattern: '^public' }, absolute: { enum: ['public choice'] },
    })
    expect((schema.$defs as any).public.description).toBe('Public definition')
    expect(JSON.stringify(schema)).not.toContain(secret)
  }
})

it('runtime enum dictionaries include only readable non-sensitive values in each language', async () => {
  const base = fixture()
  await start(defineInstance({ ...base,
    enumLabels: {
      en: { value_new: 'New', value_new_specimens: 'New specimen', value_hidden: secret, value_private: secret, unrelated: secret },
      cs: { value_new: 'Nový', value_new_specimens: 'Nový vzorek', value_hidden: secret, value_private: secret, unrelated: secret },
    },
    entities: {
      specimens: { ...base.entities.specimens, fields: { ...base.entities.specimens.fields,
        hidden_state: { type: 'enum', sensitive: true, values: ['hidden'] },
      } },
      vaults: { displayField: 'state', fields: { state: { type: 'enum', values: ['private'] } } },
    },
    permissions: { ...base.permissions, owner: { ...base.permissions.owner, vaults: ['read'] } },
    policies: { ...base.policies, vaults: { owner: 'all', viewer: 'none' } },
  }))
  const body = await contract('viewer')
  expect(body.model.enumLabels).toEqual({
    en: { value_new: 'New', value_new_specimens: 'New specimen' },
    cs: { value_new: 'Nový', value_new_specimens: 'Nový vzorek' },
  })
  expect(JSON.stringify(body.model.enumLabels)).not.toContain(secret)
})

it('explicit entity and field captions survive computed display synthesis and authority projection', async () => {
  const base = fixture()
  await start(defineInstance({ ...base,
    entities: { specimens: { ...base.entities.specimens, displayField: Fn.concat('name', Q.value('!')).serialize() } },
    enumLabels: { cs: { entity_specimens: 'Vzorky', entitySingular_specimens: 'vzorek', entityObject_specimens: 'vzorek',
      field_computed_display_specimens: 'Popis vzorku', field_name_specimens: 'Název vzorku', field_id_specimens: 'Číslo vzorku', field_secret_specimens: secret } },
  }))
  const body = await contract('viewer')
  expect(body.model.enumLabels?.cs).toMatchObject({ entity_specimens: 'Vzorky', entitySingular_specimens: 'vzorek', entityObject_specimens: 'vzorek', field_name_specimens: 'Název vzorku', field_id_specimens: 'Číslo vzorku' })
  const owner = await contract('owner')
  expect(owner.model.enumLabels?.cs).toMatchObject({ field_computed_display_specimens: 'Popis vzorku', listField_computed_display_specimens: 'Popis vzorku' })
  expect(JSON.stringify(owner.model.enumLabels)).not.toContain(secret)
})
