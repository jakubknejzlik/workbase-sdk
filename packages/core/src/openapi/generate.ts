import type { z } from 'zod'
import { isAccountAccessCommand } from '../account-command'
import { canonical } from '../access-lock'
import { baseFields, bodyValidator } from '../model-inputs'
import type { Field, InstanceConfig } from '../config'
import type { KernelRegistry } from '../kernel/registry'
import { publicCommandDefinitions, publicFields, publicPolicies, publicQuery } from '../public-projection'
import { labelDependencies } from '../query/labels'
import { querySchema } from '../query/input-schema'
import { publicInputSchema } from './input-projection'
import { publicPaths, object, array, ref, string, boolean, nullable, response, request, parameter, operation, type Schema } from './public-paths'

const sorted = (values: readonly string[]) => [...new Set(values)].sort()
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function scalar(field: Pick<Field, 'type' | 'values'>): Schema {
  return field.type === 'bool' ? boolean : field.type === 'int' ? { type: 'integer' }
    : field.type === 'float' ? { type: 'number' } : field.type === 'enum' ? { type: 'string', enum: field.values } : string
}
/** Rebase Zod's local recursive references when embedding a schema in components. */
function rebaseInput(input: Schema, name: string): Schema {
  function rebase(node: any): any {
    if (Array.isArray(node)) return node.map(rebase)
    if (!node || typeof node !== 'object') return node
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key,
      key === '$ref' && typeof value === 'string' && value.startsWith('#') ? `#/components/schemas/${name}${value.slice(1)}`
        : ['required', 'type'].includes(key) && Array.isArray(value) ? sorted(value) : rebase(value)]))
  }
  return rebase(input)
}
function permission(value: any): Schema {
  return 'system' in value ? { system: value.system } : { entity: value.entity, operation: value.operation }
}

/** Build-time only, with no actor, environment, database, filesystem or clock input. */
export function generate(config: InstanceConfig, kernel: Pick<KernelRegistry, 'commands' | 'workflows'>, configHash: string): string {
  const schemas: Record<string, Schema> = Object.create(null)
  const insert = (name: string, schema: Schema) => {
    if (Object.hasOwn(schemas, name)) throw new Error(`OpenAPI component collision: ${name}`)
    schemas[name] = schema
    return schema
  }
  for (const [name, schema] of Object.entries(publicPaths.schemas)) insert(name, schema)
  const inputs = new WeakMap<z.ZodType, Schema>()
  const inputSchema = (schema: z.ZodType, name: string) => {
    let input = inputs.get(schema)
    if (!input) { input = publicInputSchema(schema); inputs.set(schema, input) }
    return rebaseInput(input, name)
  }
  const paths = publicPaths()
  const commands = publicCommandDefinitions(config, kernel).map(({ name, command }) => {
    const component = `CommandInput_${name.replaceAll('/', '_')}`
    const input = insert(component, inputSchema(command.input, component))
    return { name, permission: permission(command.permission), additionalPermissions: (command.additionalPermissions ?? []).map(permission).sort((a, b) => compare(JSON.stringify(canonical(a)), JSON.stringify(canonical(b)))), inputSchema: input }
  }).sort((a, b) => compare(a.name, b.name))
  const queryRequests: Schema[] = [], queryResponses: Schema[] = []
  for (const name of Object.keys(config.entities).sort()) {
    const entity = config.entities[name]
    const actions = (config.effectiveAccess?.actions ?? []).filter(action => action.entity === name)
    const fields = publicFields(entity)
    const properties: Record<string, Schema> = Object.fromEntries(baseFields.map(field => [field, field === 'version' ? { type: 'integer' } : string]))
    for (const [key, field] of Object.entries(entity.fields)) properties[key] = {
      // Responses allow omitted fields (masks/select) and null references (visibility).
      ...(field.required && field.type !== 'ref' ? scalar(field) : nullable(scalar(field))),
      'x-workbase-field': fields[key],
    }
    for (const [key, relation] of Object.entries(entity.relations)) properties[key] = relation.many ? array(ref(`Row_${relation.entity}`)) : nullable(ref(`Row_${relation.entity}`))
    properties.__labels = { type: 'object', additionalProperties: nullable({ oneOf: [
      object({ status: { type: 'string', enum: ['unavailable'] } }),
      object({ status: { type: 'string', enum: ['ok'] }, entity: string, display: nullable(string), row: { type: 'object' } }),
    ] }) }
    properties.__display = array({ anyOf: [string, object({ type: { type: 'string', enum: ['date', 'datetime'] }, value: nullable(string) })] })
    insert(`Row_${name}`, { ...object(properties, []),
      'x-workbase-display': { ...(entity.displayField ? { displayField: entity.displayField } : {}), ...(entity.label ? { labelDependencies: labelDependencies(config, name).sort((a, b) => compare(`${a.entity}.${a.field}`, `${b.entity}.${b.field}`)) } : {}) },
      'x-workbase-relations': Object.fromEntries(Object.entries(entity.relations).map(([key, relation]) => [key, {
        entity: relation.entity, field: relation.field, cardinality: relation.many ? '1:n' : 'n:1',
        ...(relation.through ? { through: { entity: relation.through.entity, field: relation.through.field, createCommand: relation.through.createCommand, deleteCommand: relation.through.deleteCommand } } : {}),
      }])),
    })
    insert(`Detail_${name}`, object({ ...properties,
      actions: object(Object.fromEntries(actions.map(action => [action.name, object({ enabled: boolean, reason: string }, ['enabled'])])), []),
      ...(config.effectiveAccess?.accountLinks?.[name] ? { access: ref('AccountAccess') } : {}),
    }, config.baseline === 'workbase-sdk' ? ['actions'] : []))
    const writable = Object.entries(entity.fields).filter(([, field]) => !field.readOnly && !field.userLink && !field.computed).map(([key]) => key).sort()
    insert(`Create_${name}`, inputSchema(bodyValidator(entity), `Create_${name}`))
    insert(`Update_${name}`, { ...inputSchema(bodyValidator(entity, true), `Update_${name}`),
      anyOf: writable.length ? writable.map(key => ({ required: [key] })) : [{ not: {} }],
    })
    schemas[`Update_${name}`].properties.version = { type: 'integer', minimum: 1 }
    const queryName = `Query_${name}`
    insert(queryName, inputSchema(querySchema(config, name), queryName))
    schemas[queryName].properties.entity = { type: 'string', enum: [name] }
    schemas[queryName].properties.cursor.description = 'Opaque signed query cursor; bound to the query and authorization scope.'
    // querySchema emits only generated grammar/projection enums, never authored
    // field values. Normalize every set here; other input/row enums keep their order.
    const setEnums = (node: any) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node.enum)) node.enum = sorted(node.enum)
      if (Array.isArray(node.required)) node.required = sorted(node.required)
      for (const child of Object.values(node)) setEnums(child)
    }
    setEnums(schemas[queryName])
    queryRequests.push(ref(queryName))
    const page = (cursor: string) => object({ data: array(ref(`Row_${name}`)), next_cursor: { type: ['string', 'null'], description: cursor } })
    insert(`List_${name}`, page('REST cursor: last returned row id, or null. Pass as the cursor URL parameter; rows sort by id.'))
    insert(`Result_${name}`, page('Opaque signed query cursor, or null. Pass unchanged to POST /query; it is not a row id.'))
    queryResponses.push(ref(`Result_${name}`))
    const base = `/api/${name}`
    const expand = parameter('expand', 'query', { type: 'string', description: 'Comma-separated relation names, at most five.' })
    paths[base] = {
      get: operation({ '200': response(ref(`List_${name}`)) }, { parameters: [parameter('limit', 'query', { type: 'integer', minimum: 1, maximum: 90, description: 'Page size; omitted means 25.' }),
        parameter('cursor', 'query', { type: 'string', description: 'Last returned row id (REST cursor).' }), expand,
        ...Object.entries(entity.fields).sort(([a], [b]) => compare(a, b)).flatMap(([key, field]) => ['', '[gt]', '[gte]', '[lt]', '[lte]'].map(op => parameter(key + op, 'query', field.type === 'bool' ? { type: 'string', enum: ['true', 'false', '1', '0'] } : ['int', 'float'].includes(field.type) ? { type: 'number' } : string))),
      ] }),
      ...(!entity.commandsOnly ? { post: operation({ '201': response(ref(`Row_${name}`)) }, { parameters: [parameter('Idempotency-Key', 'header', { type: 'string', minLength: 1, maxLength: 128 })], requestBody: request(ref(`Create_${name}`)) }) } : {}),
    }
    paths[`${base}/{id}`] = {
      parameters: [parameter('id', 'path', string, true)],
      get: operation({ '200': response(ref(`Detail_${name}`)) }, { parameters: [expand] }),
      ...(!entity.commandsOnly ? {
        patch: operation({ '200': response(ref(`Row_${name}`)), '409': response(ref('Error'), 'Version conflict') }, {
          parameters: [parameter('If-Match', 'header', { type: 'string', description: 'Expected positive row version, optionally quoted. Required unless body.version is supplied.' })], requestBody: request(ref(`Update_${name}`)),
        }), delete: operation({ '204': { description: 'Deleted' } }),
      } : {}),
    }
    for (const action of actions) {
      const command = kernel.commands.get(action.command)
      if (!command) throw new Error(`Missing action command: ${action.command}`)
      const component = `Action_${name.length}_${name}_${action.name.length}_${action.name}`
      const input = inputSchema(command.input, component)
      for (const key of ['id', 'rowId', 'role']) { delete input.properties?.[key]; input.required = input.required?.filter((value: string) => value !== key) }
      insert(component, input)
      const accountAction = isAccountAccessCommand(config, action.command)
      const result = accountAction ? action.name === 'invite' ? object({ invitation_id: string, expires_at: string, accept_url: string }) : object({ id: string }) : {}
      paths[`${base}/{id}/actions/${action.name}`] = { parameters: [parameter('id', 'path', string, true)], post: operation({
        ...(accountAction ? { [action.name === 'invite' ? '201' : '200']: response(result) } : { '2XX': response(result, 'Command result') }),
        '409': response({ anyOf: [object({ error: { type: 'string', enum: ['action_unavailable'] }, reason: string }), ref('Error')] }, 'Unavailable action includes reason; command conflicts use Error'),
      }, { requestBody: request(ref(component)) }) }
    }
  }
  paths['/query'] = { post: operation({ '200': response({ anyOf: queryResponses }) }, { requestBody: request({ oneOf: queryRequests }), description: 'Filter-object query. Cursors are opaque signed tokens, distinct from REST last-id cursors.' }) }
  for (const command of commands) {
    const component = `Command_${command.name.replaceAll('/', '_')}`
    // Names may contain slashes and underscores; fail rather than silently alias components.
    insert(component, structuredClone(command.inputSchema))
    if (schemas[component].type === 'object') schemas[component].properties.idempotencyKey = { type: 'string', minLength: 1, maxLength: 128 }
    paths[`/commands/${command.name}`] = { post: operation({ '200': response({}, 'Command result'), '201': response({}, 'Command result'), '405': response(ref('Error'), 'Unsupported command (including record-only adapters)') }, { requestBody: request(ref(component)) }) }
  }
  const workflows = [...kernel.workflows.values()].map(workflow => {
    const component = `WorkflowInput_${workflow.name.replaceAll('/', '_')}`
    const input = insert(component, inputSchema(workflow.input, component))
    return { name: workflow.name, version: workflow.version, inputSchema: input,
      permissions: workflow.steps?.map(step => ({ name: step.operation.name, permission: permission(step.operation.permission) })).sort((a, b) => compare(a.name, b.name)),
    }
  }).sort((a, b) => compare(a.name, b.name))
  const doc = {
    openapi: '3.1.0', info: { title: config.id, version: `r${config.revision}` }, paths,
    components: { schemas, securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: '__Host-workbase.session' }, bearer: { type: 'http', scheme: 'bearer' } } },
    'x-workbase-revision': config.revision, 'x-workbase-config-hash': configHash,
    'x-workbase-permissions': { roles: sorted(config.roles), resources: Object.fromEntries(Object.entries(config.permissions).map(([role, resources]) => [role, Object.fromEntries(Object.entries(resources).map(([name, operations]) => [name, sorted(operations)]))])), entities: publicPolicies(config) },
    'x-workbase-query': publicQuery(config), 'x-workbase-commands': commands,
    'x-workbase-workflows': workflows,
  }
  const bytes = JSON.stringify(canonical(doc), null, 2) + '\n'
  if (JSON.stringify(canonical(JSON.parse(bytes)), null, 2) + '\n' !== bytes) throw new Error('OpenAPI canonical round-trip failed')
  return bytes
}
