import { projection, visibleEntities, type Model, type Capabilities, type ReadQuery, type Command } from './read'
import { formFieldOrder } from './hints'
import { editableManyRelations, manyRelationSchema } from './many-to-many'
/** RFC 0005 decisions 3/7/10: capability masks are authoritative, including $actor fields. */
export function writableFields(model: Model, entity: string, caps: Capabilities) {
  const definition = model.entities[entity]
  const inputs = [...new Set([...definition.columns, ...Object.keys(definition.writeSchema?.properties ?? {}), ...Object.keys(definition.updateSchema?.properties ?? {})])]
  return inputs.filter(field => caps.entities[entity]?.writable.includes(field) && !definition.fields[field]?.readOnly && !definition.fields[field]?.ui?.hidden)
}
/** Inline editing narrows the existing edit form; presentation never grants a write. */
export function inlineEditableField(model: Model, entity: string, caps: Capabilities, name: string) {
  const definition = model.entities[entity]; const grant = caps.entities[entity]
  const field = definition.fields[name]
  return definition.detail?.inlineEdit === true && visibleEntities(model, caps).includes(entity)
    && grant.operations.includes('update') && grant.readable.includes('version') && grant.readable.includes(name)
    && !!field && !field.readOnly && !field.ui?.hidden
    && ['string', 'text', 'int', 'float', 'number', 'enum', 'bool', 'date', 'datetime', 'ref'].includes(field.type)
    && (field.type !== 'ref' || !!field.entity && visibleEntities(model, caps).includes(field.entity))
    && Object.hasOwn(writeSchema(model, entity, caps, 'edit').properties, name)
}
export function writeSchema(model: Model, entity: string, caps: Capabilities, view: 'create' | 'edit' = 'create') {
  const definition = model.entities[entity]
  const schema = (view === 'edit' ? definition.updateSchema ?? definition.writeSchema : definition.writeSchema) ?? { type: 'object', properties: {} }
  const fields = writableFields(model, entity, caps).filter(field => Object.hasOwn(schema.properties ?? {}, field))
  const masked = manyRelationSchema({ ...schema,
    properties: Object.fromEntries(fields.map(field => [field, { ...schema.properties[field], 'x-ui': formFieldMetadata(schema.properties[field], definition.fields[field]) }])),
    required: (schema.required ?? []).filter((field: string) => fields.includes(field)),
  }, editableManyRelations(model, entity, caps))
  // Select only after scalar and relation authorization. Explicit fields are an allowlist;
  // the instance hint is ordering only and appends unspecified authorized properties.
  const explicit = definition.form?.[view]?.fields
  const order = explicit ?? formFieldOrder[model.instance]?.[entity] ?? schema['x-ui']?.fieldOrder ?? fields
  const selected = explicit ?? Object.keys(masked.properties)
  return { ...masked, 'x-ui': { ...schema['x-ui'], fieldOrder: order },
    properties: Object.fromEntries(selected.filter(field => Object.hasOwn(masked.properties, field)).map(field => {
      const raw = masked.properties[field]
      const section = definition.sections?.find(section => section.fields.includes(field))
      return [field, section ? { ...raw, 'x-ui': { ...raw['x-ui'], section: `section:${section.id}` } } : raw]
    })),
    required: masked.required.filter((field: string) => selected.includes(field)),
  }
}
/** Semantic schema types become explicit presentation metadata; names never determine policy or widgets. */
export function formFieldMetadata(raw: Record<string, any>, field?: { type: string; ui?: Record<string, unknown> }) {
  const nonNull = raw.anyOf?.find((item: any) => item.type !== 'null') ?? raw
  const spec = Array.isArray(nonNull.type) ? { ...nonNull, type: nonNull.type.find((type: string) => type !== 'null') } : nonNull
  const kind = spec.enum ? 'select' : spec.type === 'boolean' ? 'boolean' : ['integer', 'number'].includes(spec.type) ? 'number'
    : spec.format === 'date-time' ? 'datetime' : spec.format === 'date' ? 'date' : spec.format === 'time' ? 'time'
    : field?.type === 'text' || ['array', 'object'].includes(spec.type) || spec.maxLength > 2000 ? 'textarea' : 'input'
  return { kind, span: kind === 'textarea' || field?.type === 'ref' || spec.referenceEntity ? 'full' : 'half', ...raw['x-ui'], ...field?.ui }
}
export function commandFormSchema(schema: Record<string, any>) {
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, raw]) => [name, { ...(raw as object), 'x-ui': formFieldMetadata(raw as Record<string, any>) }])) }
}
export function commandDefinitions(model: Model, entity: string, caps: Capabilities) {
  return (model.commands ?? []).filter(command => (command.ui?.placement?.entity === entity || command.permission.entity === entity) && caps.commands?.includes(command.name)
    && Object.entries(command.inputSchema.properties ?? {}).every(([name, field]: [string, any]) => !command.inputSchema.required?.includes(name) || !field.referenceEntity || visibleEntities(model, caps).includes(field.referenceEntity))
    && !(command.ui?.replacesCrud && caps.entities[entity]?.operations.includes(command.ui.replacesCrud)))
}
/** Collection actions exclude row bindings. CRUD and command creates share one primary slot. */
export function listCommandActions(model: Model, entity: string, caps: Capabilities) {
  const commands = commandDefinitions(model, entity, caps).filter(command => !commandRowField(command, entity))
  const creates = (command: Command) => command.ui?.placement?.entity === entity && command.ui.placement.action === 'create' || command.ui?.replacesCrud === 'create' || command.permission.operation === 'create'
  return {
    create: caps.entities[entity]?.operations.includes('create') ? undefined : commands.find(creates),
    secondary: commands.filter(command => !creates(command)),
  }
}
/** Labels are presentation metadata, then a translated/humanized final command segment. */
export function commandLabel(command: Command, language: string, translate: (key: string, options: { defaultValue: string; context?: string }) => string) {
  const label = command.ui?.label
  const localized = typeof label === 'string' ? label : label?.[language.startsWith('cs') ? 'cs' : 'en']
  if (command.ui?.labelKey) return translate(command.ui.labelKey, { defaultValue: localized ?? command.name.split('/').at(-1)!, context: command.permission.entity })
  if (localized) return localized
  const name = command.name.split('/').at(-1)!
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  return translate(`commandName_${name}`, { defaultValue: words.charAt(0).toLocaleUpperCase(language) + words.slice(1) })
}
/** Only an unambiguous scalar reference in the published schema binds a command to a row. */
export function commandRowField(command: NonNullable<Model['commands']>[number], entity: string) {
  const fields = Object.entries(command.inputSchema.properties ?? {}).filter(([, field]: [string, any]) => field.type === 'string' && field.referenceEntity === entity)
  return fields.length === 1 ? fields[0][0] : undefined
}
export function rowCommands(model: Model, entity: string, caps: Capabilities) {
  return commandDefinitions(model, entity, caps).flatMap(command => {
    const rowField = commandRowField(command, entity)
    return rowField ? [{ ...command, rowField }] : []
  })
}
export function hasRowActions(model: Model, entity: string, caps: Capabilities) {
  return visibleEntities(model, caps).includes(entity) && (caps.entities[entity].operations.some(operation => operation === 'delete' || operation === 'update' && caps.entities[entity].readable.includes('version')) || rowCommands(model, entity, caps).length > 0)
}
export function pickerQuery(model: Model, entity: string, caps: Capabilities, options: { search?: string; cursor?: string; ids?: string[]; locale?: 'en' | 'cs' } = {}): ReadQuery {
  const select = projection(model, entity, caps)
  const display = caps.entities[entity]?.displayField ?? model.entities[entity].displayField
  const query: ReadQuery = { entity, limit: Math.min(30, model.limits.root), select, orderBy: [{ field: 'id', dir: 'asc' }] }
  if (options.ids) query.where = { id: { in: options.ids } }
  else if (options.search?.trim() && display && select.includes(display)) {
    const type = model.entities[entity].fields[display]?.type
    if (['string', 'text'].includes(type)) query.where = { [display]: { contains: options.search.trim() } }
    // The shared search compiler handles stored numeric/date text and localized enum labels.
    else if (['date', 'datetime', 'int', 'float', 'number', 'enum'].includes(type)) query.search = { text: options.search.trim(), fields: [display], locale: options.locale ?? 'en' }
  }
  if (options.cursor) query.cursor = options.cursor
  return query
}

export const writeCodes = ['relation_save_failed', 'validation_error', 'version_conflict', 'field_forbidden', 'policy_violation', 'not_found', 'constraint_conflict', 'idempotency_payload_mismatch', 'rule_failed', 'invalid_transition']
export function commandError(failure: { status?: number; code?: string }) {
  const closed = writeCodes.includes(failure.code ?? '')
  const denied = failure.status === 403 && ['permission_denied', 'organization_forbidden', 'membership_required'].includes(failure.code ?? '')
  return { denied, key: failure.status === 404 ? 'notFoundDescription' : closed ? `write_${failure.code}` : denied ? 'forbiddenDescription' : 'requestFailed' }
}
