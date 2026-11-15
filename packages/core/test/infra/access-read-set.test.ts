import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { z } from 'zod'
import { accessEntities, accessSystemActions, bindSchemaLock, defineAccess, defineConfig, defineEntity } from '../../src/schema'
import { Fn, Q } from '../../src/config'
import { KernelRegistry, bindKernel } from '../../src/kernel/registry'
import { createCommandRegistry } from '../../src/commands'
import { createWorkflowRegistry } from '../../src/workflow-runtime'
import { serializeAccessLock } from '../../src/access-lock'
import { sealActor, requireScope } from '../../src/authorization'
import { capabilities } from '../../src/capabilities'
import { effectiveAuthorityLayers } from '../../src/access-evaluator'
import { assertActorFields, canManageAccountAssignments, loadActorProjection, policyFilter, rolePolicyFilter, readableFields, writableFields } from '../../src/policies'
import { readableComputed } from '../../src/query/expressions'
import { labelDependencies, readableDisplay, readableLabel } from '../../src/query/labels'
import { validateQuery } from '../../src/query/schema'
import { compileRoot } from '../../src/query/compiler'
import { enforcePlan, writeFilter } from '../../src/execution/policies'
import { needsPolicyReceipt } from '../../src/execution/policy-receipts'
import { atomicPermission } from '../../src/execution/permissions'
import type { AtomicOperation } from '../../src/execution/types'
import type { WorkflowDefinition } from '../../src/execution/workflow'
import type { RuntimeEnv } from '../../src/types'
import { ReadSet, assertReadSetCovered, type Mapping, type Exception } from './access-read-set'

const options = {
  root: resolve('.'),
  sources: Object.fromEntries(['entities', 'access', 'commands', 'plugins', 'workflows', 'ui'].map(key =>
    [key, { file: 'packages/core/test/infra/access-read-set.test.ts', line: 1, column: 1 }])),
}
async function fixture(composition: 'plugin' | 'runtime' | 'factory') {
  const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' } as const
  const roles = ['admin', 'staff']
  const matrix = { admin: all, staff: 'deny' } as const
  const access = defineAccess({ predicates: {},
    roles: Object.fromEntries(roles.map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) }])),
    entities: Object.fromEntries(accessEntities.map(entity => [entity, matrix])),
  })
  const input = defineConfig({ id: 'read_set', interactive: false, languages: ['en'], roles, organizationOwnerRole: 'admin', access,
    entities: {
      contacts: defineEntity({ fields: { name: { type: 'string' }, secret: { type: 'string', sensitive: true }, label_value: { type: 'string', readOnly: true } }, displayField: 'name', access: matrix }),
      clients: defineEntity({ fields: { name: { type: 'string' }, contact_id: { type: 'ref', entity: 'contacts' }, label_value: { type: 'string', readOnly: true } }, displayField: 'name', access: matrix }),
      jobs: defineEntity({ fields: { title: { type: 'string' }, client_id: { type: 'ref', entity: 'clients' }, description: { type: 'string', computed: '#client_id#' }, summary: { type: 'string', computed: Q.expr('description').serialize() } },
        relations: { client: { entity: 'clients', field: 'client_id' } }, displayField: 'title',
        access: { ...matrix, admin: { ...all, read: { where: { client: { name: { ne: '$actor.id' } } } } } } }),
    },
    ui: { entities: { jobs: { list: { relatedColumns: { contact: { via: 'client_id', field: 'contact_id' } } } } } },
  })
  input.account = { entity: 'users', assignments: ['name'], managedBy: ['admin'] }
  // Supported normalized label seam, as in slice 1; no expansion of authoring API.
  input.entities.clients.displayField = 'label_value'
  input.entities.clients.label = Fn.concat('contact_id.label_value', Q.value('!'))
  input.entities.contacts.displayField = 'label_value'
  input.entities.contacts.label = Fn.concat('name', Q.value('!'))
  const operation: AtomicOperation = { name: 'jobs/shared', permission: { entity: 'jobs', operation: 'read' },
    additionalPermissions: [{ entity: 'clients', operation: 'read' }], input: z.object({}), plan() { throw new Error('opaque plan') } }
  const workflow: WorkflowDefinition = { name: 'jobs/review', version: '1', input: z.object({}), steps: [{
    id: 'review', operation: { ...operation }, sideEffect: true,
    policy: { maxAttempts: 1, backoffMs: 0, timeoutMs: 1, deadlineMs: 1 },
    async run() { throw new Error('opaque run') },
    compensate: { operation: { ...operation, permission: { entity: 'clients', operation: 'read' } }, async run() { throw new Error('opaque compensation') } },
  }] }
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ user_id: 'admin', organization_id: 'org', role: 'admin' }) }) }) } } as unknown as RuntimeEnv
  const kernel = new KernelRegistry(bindSchemaLock(input, { lockVersion: 1, revision: 1, parent: null, tables: [] }), {
    commands: createCommandRegistry([operation]),
    plugins: [{ name: 'recorder', version: '1', provides: { permissions: '1.x' }, authorization: true,
      tableFilter: () => ({ kind: 'all' }), fieldMask(entity) { return readableFields(this.config, entity, currentScope) }, commandGuard: () => ({ allow: true }),
      ...(composition === 'plugin' ? { workflows: [workflow] } : {}),
      ...(composition === 'factory' ? { workflowDefinitions: () => createWorkflowRegistry([workflow]) } : {}),
    }], ...(composition === 'runtime' ? { workflows: createWorkflowRegistry([workflow]) } : {}),
  }, env)
  const actor = sealActor({ actor: { type: 'user', id: 'admin' }, user: { id: 'admin', email: 'admin@example.test' }, organizations: [] },
    { env, hash: 'synthetic', session: { valid: async () => true, verified: async () => true, recipientVerification: 'local-profile' } })
  const currentScope = await requireScope(actor, 'org')
  // Fresh objects per scenario avoid hiding reads behind expression/config caches.
  // Keep the original kernel registered for the replacement config identity.
  const recorder = new ReadSet()
  const raw = { config: kernel.config, plugins: kernel.plugins, commands: kernel.commands, workflows: kernel.workflows, providers: kernel.providers }
  const config = recorder.wrap(raw.config, ['config'])
  bindKernel(raw.config, config)
  Object.defineProperties(kernel, {
    config: { value: config }, plugins: { value: recorder.wrap(raw.plugins, ['plugins']) },
    commands: { value: recorder.map(raw.commands, ['commands']) }, workflows: { value: recorder.map(raw.workflows, ['workflows']) },
    providers: { value: recorder.map(raw.providers, ['providers']) },
  })
  // Serialize raw inputs after enforcement; lock generation must never contribute
  // a read to the consumer recorder or make its own coverage assertion pass.
  const lock = () => JSON.parse(serializeAccessLock({ ...kernel, ...raw, authorizationTrust: kernel.authorizationTrust }, options).json)
  return { kernel, raw, recorder, scope: currentScope, lock }
}

// An independent adapter from consumer provenance to *parsed serialized values*.
// It imports neither enforcementInputs nor its keys. Projected records have closed
// property sets; complete dictionaries (fields, relations, policies) also represent
// negative membership lookups. No arbitrary ancestor counts as leaf coverage.
function mapping(raw: Awaited<ReturnType<typeof fixture>>['raw'], lock: any): Mapping {
  const inputs = lock.enforcementInputs
  const at = (root: any, path: string[], location: string) => ({ value: path.reduce((value, key) => value?.[key], root), location: [location, ...path].join('.') })
  const guardMap = Object.fromEntries(lock.effectiveAccess.guards.map((guard: any) => [guard.name, guard]))
  const operationAt = (value: any, path: string[], location: string) => {
    if (!path.length) return at(value, [], location)
    const [part, index, property] = path
    if (!['name', 'permission', 'additionalPermissions'].includes(part)) return
    if (part === 'permission' && index && !['system', 'entity', 'operation'].includes(index)) return
    if (part === 'additionalPermissions' && index && !/^(length|\d+)$/.test(index)) return
    if (part === 'additionalPermissions' && property && !['system', 'entity', 'operation'].includes(property)) return
    return at(value, path, location)
  }
  return read => {
    const [root, ...path] = read.path
    if (root === 'config') {
      const [section, ...rest] = path
      if (section === 'effectiveAccess') return at(lock.effectiveAccess, rest, 'effectiveAccess')
      if (['account', 'organizationOwnerRole', 'roles', 'permissions', 'policies', 'organizationPermissions'].includes(section)) {
        if (section === 'account' && !rest.length && read.value === undefined) return { value: inputs.account ?? undefined, location: 'enforcementInputs.account' }
        return at(inputs[section], rest, `enforcementInputs.${section}`)
      }
      if (section === 'ui') {
        if (rest.length <= 2 || rest[2] === 'list' && (rest.length === 3 || rest[3] === 'relatedColumns')) return at(inputs.ui, rest, 'enforcementInputs.ui')
      }
      if (section === 'entities') {
        if (rest.length <= 1) return at(inputs.entities, rest, 'enforcementInputs.entities')
        const [, part, , property] = rest
        if (['commandsOnly', 'displayField', 'label', 'relations', 'fields'].includes(part)) {
          if (part === 'fields' && rest.length > 3 && !['type', 'entity', 'computed', 'readOnly', 'sensitive', 'userLink', 'values'].includes(property)) return
          if (part === 'relations' && rest.length > 3 && !['entity', 'field', 'many'].includes(property)) return
          const result = at(inputs.entities, rest, 'enforcementInputs.entities')
          if (read.kind === 'get' && ['commandsOnly', 'readOnly', 'sensitive', 'userLink'].includes(rest.at(-1)!) && read.value === undefined && result.value === false) return { ...result, value: undefined }
          return result
        }
      }
    }
    if (root === 'commands') {
      if (!path.length || path.length === 1) return at(guardMap, path, 'effectiveAccess.guards[name]')
      return operationAt(guardMap[path[0]], path.slice(1), `effectiveAccess.guards[${path[0]}]`)
    }
    if (root === 'workflows') {
      const [name, part, index, role, ...rest] = path
      const workflow = inputs.workflows[name]
      if (path.length === 0) return at(inputs.workflows, [], 'enforcementInputs.workflows')
      if (path.length === 1) return at(workflow, [], `enforcementInputs.workflows.${name}`)
      if (part === 'name') return { value: workflow ? name : undefined, location: 'enforcementInputs.workflows key' }
      if (part === 'version') return at(workflow, ['version'], `enforcementInputs.workflows.${name}`)
      if (part !== 'steps') return
      if (!index || index === 'length') return at(workflow?.stepOrder, index ? ['length'] : [], `enforcementInputs.workflows.${name}.stepOrder`)
      const id = raw.workflows.get(name)?.steps?.[Number(index)]?.id
      const step = workflow?.steps[id!]
      if (!role) return at(step, [], `enforcementInputs.workflows.${name}.steps.${id}`)
      if (role === 'id') return { value: workflow?.stepOrder[Number(index)], location: 'enforcementInputs.workflows.*.stepOrder' }
      if (role === 'operation') return operationAt(step?.forward, rest, `enforcementInputs.workflows.${name}.steps.${id}.forward`)
      if (role === 'compensate') return operationAt(step?.compensation, rest[0] === 'operation' ? rest.slice(1) : rest, `enforcementInputs.workflows.${name}.steps.${id}.compensation`)
    }
    if (root === 'plugins') {
      if (path.length === 0 || path[0] === 'length') return at(inputs.plugins, path, 'enforcementInputs.plugins')
      const plugin = raw.plugins[Number(path[0])]
      const projected = inputs.plugins.find((entry: any) => entry.name === plugin?.name)
      const rest = path.slice(1)
      if (['tableFilter', 'fieldMask', 'commandGuard'].includes(rest[0])) return {
        value: projected?.hooks.includes(rest[0]) ? read.value : undefined, location: 'enforcementInputs.plugins[*].hooks',
      }
      if (!rest.length || ['name', 'version', 'authorization', 'policyInConfig'].includes(rest[0])) {
        const result = at(projected, rest, 'enforcementInputs.plugins[name]')
        return read.value === undefined && result.value === false ? { ...result, value: undefined } : result
      }
    }
    if (root === 'providers' && (path.length <= 2 || path.length === 3 && ['name', 'version'].includes(path[2]))) {
      return at(inputs.authorization.providers, path, 'enforcementInputs.authorization.providers')
    }
  }
}

// Narrow exceptions for reads exercised here. There is deliberately no wildcard
// for arbitrary SDK reads, plugin config, workflow metadata or entity properties.
const exceptions: Exception = read => {
  if (read.path[0] === 'config' && read.path[1] === 'commands' && (read.path.length === 2 || read.path.length === 3 && /^(length|\d+)$/.test(read.path[2]))) return 'Command publication filter for capabilities only; execution checks the separately serialized guard registry. Runtime commands may be guarded without being advertised.'
  if (read.kind === 'get' && (read.value === undefined || typeof read.value === 'function') && /^(commands\.[^.]+|workflows\.[^.]+\.steps\.\d+\.(operation|compensate\.operation))\.plan$/.test(read.path.join('.'))) return 'operationName inspects executable plan presence; command/workflow executable bodies are explicitly opaque.'
  if (read.kind === 'get' && read.path.join('.') === 'config.revision') return 'Capability response version only; does not authorize access.'
  if (/^config\.(effectiveAccess\.entities\.\d+\.where|policies\.[^.]+\.[^.]+\.where)(\.[^.]+)*\.toJSON$/.test(read.path.join('.')) && read.kind === 'get' && read.value === undefined) return 'JSON.stringify protocol lookup; no custom executable serializer is present.'
  return undefined
}

async function exercise(f: Awaited<ReturnType<typeof fixture>>) {
  const { kernel, scope, recorder } = f
  recorder.scenario = 'actor/account policy and write enforcement'
  await loadActorProjection(kernel.config, scope, async <T>() => ({ id: 'admin', role: 'admin', organization_id: 'org' }) as T,
    { user_id: 'admin', organization_id: 'org', role: 'admin' })
  canManageAccountAssignments(kernel.config, scope, ['name'])
  assertActorFields(kernel.config, scope, 'jobs', ['title'])
  for (const entity of ['jobs', 'clients', 'contacts']) {
    policyFilter(kernel.config, entity, scope); rolePolicyFilter(kernel.config, entity, scope, 'admin'); writableFields(kernel.config, entity, scope)
    writeFilter(kernel, scope, entity)
  }
  enforcePlan(kernel, scope, { rules: [{ name: 'update', statements: [{ sql: 'UPDATE jobs SET title=? WHERE id=?', bindings: ['new', 'job'] }] }], result: { status: 200, body: {} }, event: { operation: 'update', entity: 'jobs', entityId: 'job' } })
  needsPolicyReceipt(kernel)
  recorder.scenario = 'deny/intersection, masks and command guards'
  const authority = effectiveAuthorityLayers(kernel.config.effectiveAccess!, [['admin'], ['staff']])
  expect(authority.permits({ entity: 'jobs', operation: 'read' })).toBe(false)
  authority.fields('jobs')
  for (const command of kernel.commands.values()) {
    try { atomicPermission(kernel.config, scope, command) } catch (error) { expect(error).toMatchObject({ status: 403 }) }
  }
  recorder.scenario = 'query, computed dependencies, structured labels and related columns'
  expect(readableComputed(kernel, scope, 'jobs', 'summary')).toBe(true)
  expect(readableDisplay(kernel, scope, 'clients')).toBe('label_value')
  expect(readableLabel(kernel, scope, 'jobs', 'contact')).toBeDefined()
  labelDependencies(kernel.config, 'clients')
  const { query, cost } = validateQuery(kernel, scope, { entity: 'jobs', select: ['id', 'summary'], labels: ['contact'], where: { client: { name: { ne: '' } } }, limit: 1 })
  expect(compileRoot(kernel, scope, query, undefined, cost).sql).toContain('SELECT')
  recorder.scenario = 'capabilities and workflow forward/compensation authorization'
  expect(capabilities(kernel, scope).workflows['jobs/review']).toContain('start')
  expect(kernel.workflows.has('absent')).toBe(false)
  expect(kernel.workflows.get('absent')).toBeUndefined()
  expect([...kernel.workflows.keys()]).toEqual(['jobs/review'])
  for (const [name, workflow] of kernel.workflows) {
    expect(kernel.workflows.get(name)).toBe(workflow)
    for (const step of workflow.steps!) {
      atomicPermission(kernel.config, scope, step.operation)
      if (step.compensate) atomicPermission(kernel.config, scope, step.compensate.operation)
    }
  }
}

it.each(['plugin', 'runtime', 'factory'] as const)('%s composition: every exercised enforcement read is represented in the serialized lock', async composition => {
  const f = await fixture(composition)
  await exercise(f)
  const reads = [...f.recorder.reads.values()]
  expect(reads.some(read => read.kind === 'keys' && read.path.join('.') === 'config.entities')).toBe(true)
  expect(reads.some(read => read.kind === 'has' && read.path[0] === 'workflows')).toBe(true)
  const size = f.recorder.reads.size
  assertReadSetCovered(reads, mapping(f.raw, f.lock()), exceptions)
  expect(f.recorder.reads.size).toBe(size)
})

it('fails actionably when a temporary enforcement input is absent from the lock', async () => {
  const f = await fixture('runtime')
  // A new consumer read, with grants/serializer untouched. A curated input list
  // alone would miss it. Exercise an actual plugin guard with its bound kernel.
  const entity = f.raw.config.entities.jobs as typeof f.raw.config.entities.jobs & { recorderProbe?: boolean }
  entity.recorderProbe = true
  f.raw.plugins[0].commandGuard = function () {
    if (!(this.config.entities.jobs as typeof entity).recorderProbe) return { allow: false, code: 'probe_denied' }
    return { allow: true }
  }
  const before = f.lock()
  try {
    f.recorder.scenario = 'temporary plugin enforcement mutation'
    f.kernel.atomicPermission(f.scope, f.kernel.commands.get('jobs/shared')!)
    expect(() => assertReadSetCovered(f.recorder.reads.values(), mapping(f.raw, before), exceptions))
      .toThrow(/temporary plugin enforcement mutation: get config.entities.jobs.recorderProbe — no serialized lock input/)
    delete entity.recorderProbe
    expect(f.lock()).toEqual(before)
  } finally { delete entity.recorderProbe }
})


it('rejects absent-property and membership reads outside the projected entity shape', async () => {
  const f = await fixture('runtime')
  f.recorder.scenario = 'new absent guard'
  const entity = f.kernel.config.entities.jobs as typeof f.kernel.config.entities.jobs & { futureGuard?: boolean }
  expect(entity.futureGuard).toBeUndefined()
  expect('futureGuard' in entity).toBe(false)
  expect(Object.hasOwn(entity, 'futureGuard')).toBe(false)
  const command = f.kernel.commands.get('jobs/shared')! as AtomicOperation & { futureGuard?: boolean }
  expect(command.futureGuard).toBeUndefined()
  const reads = [...f.recorder.reads.values()].filter(read => read.path.at(-1) === 'futureGuard')
  expect(reads.map(read => read.kind).sort()).toEqual(['get', 'get', 'has'])
  expect(() => assertReadSetCovered(reads, mapping(f.raw, f.lock()), exceptions))
    .toThrow(/new absent guard: get config.entities.jobs.futureGuard/)
  expect(() => assertReadSetCovered(reads.filter(read => read.path[0] === 'commands'), mapping(f.raw, f.lock()), exceptions))
    .toThrow(/get commands.jobs\/shared.futureGuard — no serialized lock input/)
})

it('requires the actual serialized leaves and dictionary membership, beyond container coverage', async () => {
  const f = await fixture('runtime')
  await exercise(f)
  const complete = f.lock()
  const mutations = [
    (lock: any) => { delete lock.enforcementInputs.entities.clients.displayField },
    (lock: any) => { delete lock.enforcementInputs.entities.clients.label },
    (lock: any) => { delete lock.enforcementInputs.ui.entities.jobs.list.relatedColumns.contact.field },
    (lock: any) => { delete lock.enforcementInputs.entities.jobs.fields.title },
    (lock: any) => { delete lock.effectiveAccess.guards.find((guard: any) => guard.name === 'jobs/shared').permission },
    (lock: any) => { delete lock.enforcementInputs.workflows['jobs/review'].steps.review.forward.permission },
    (lock: any) => { delete lock.enforcementInputs.workflows['jobs/review'].steps.review.compensation.additionalPermissions },
  ]
  for (const mutate of mutations) {
    const lock = structuredClone(complete)
    mutate(lock)
    expect(() => assertReadSetCovered(f.recorder.reads.values(), mapping(f.raw, lock), exceptions)).toThrow(/Uncovered enforcement reads/)
  }
  assertReadSetCovered(f.recorder.reads.values(), mapping(f.raw, complete), exceptions)
})

it('records empty Map enumeration and keeps Map receivers, iterators and value identity usable', () => {
  const recorder = new ReadSet()
  const empty = recorder.map(new Map<string, object>(), ['empty'])
  expect([...empty.values()]).toEqual([])
  expect(recorder.reads.get(JSON.stringify([['empty'], 'keys']))?.value).toEqual([])
  const map = recorder.map(new Map([['entry', { permission: 'read' }]]), ['registry'])
  expect(map.size).toBe(1)
  expect(map.has('entry')).toBe(true)
  expect(map.get('entry')).toBe([...map.values()][0])
  expect(map.get('entry')).toBe([...map.entries()][0][1])
  expect([...map.keys()]).toEqual(['entry'])
  expect(map.get('entry')!.permission).toBe('read')
  expect([...recorder.reads.values()].map(read => [read.path.join('.'), read.kind])).toContainEqual(['registry.entry.permission', 'get'])
})
