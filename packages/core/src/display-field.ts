import { baseFields, type InstanceConfig } from './config'

/** Shared by config validation and the served /schema deployment probe. */
interface DisplayEntity {
  displayField?: string
  fields: Record<string, { type: string; required?: boolean; sensitive?: boolean; entity?: string }>
  relations?: Record<string, { entity: string; through?: { entity: string } }>
}
interface DisplaySchema {
  entities: Record<string, DisplayEntity>
  permissions: Record<string, Record<string, readonly string[]>>
  policies?: Record<string, Record<string, string | { fields?: string[] } | boolean>>
}

export interface DisplayFieldIssue {
  code: 'invalid_display_field'
  entity: string
  message: string
  suggestedChange?: { kind: 'set_display_field'; entity: string; displayField: string }
}
export class DisplayFieldError extends Error {
  readonly code = 'invalid_display_field'
  // Only attached by defineInstance after every other validation has passed.
  config?: InstanceConfig
  constructor(public errors: DisplayFieldIssue[]) {
    super(errors.map(error => error.message).join('\n'))
  }
}
// Node's isolated TypeScript module loader can instantiate a second SDK class.
export function isDisplayFieldError(error: unknown): error is DisplayFieldError {
  return error instanceof Error && 'code' in error && error.code === 'invalid_display_field' && 'errors' in error && Array.isArray(error.errors)
}

export function suggestedDisplayField(entity: DisplayEntity, readable = (key: string) => !entity.fields[key].sensitive): string | undefined {
  return Object.keys(entity.fields).find(key => entity.fields[key].required && entity.fields[key].type === 'string' && readable(key))
}

// Explicit operations can check a named entity even when the schema gate exempts it.
export function displayFieldErrors(schema: DisplaySchema, entityNames?: Iterable<string>): DisplayFieldIssue[] {
  const errors: DisplayFieldIssue[] = []
  // Every entity with a read grant can be opened as a console list. Navigation
  // hiding is presentation only; ref/relation targets also need picker labels.
  const required = new Set(entityNames ?? Object.values(schema.permissions).flatMap(grants => Object.keys(grants).filter(name => grants[name].includes('read'))))
  if (!entityNames) for (const entity of Object.values(schema.entities)) {
    for (const field of Object.values(entity.fields)) if (field.type === 'ref' && field.entity) required.add(field.entity)
    for (const relation of Object.values(entity.relations ?? {})) {
      required.add(relation.entity)
      if (relation.through) required.add(relation.through.entity)
    }
  }
  for (const name of required) {
    const entity = schema.entities[name]
    if (!entity) {
      errors.push({ code: 'invalid_display_field', entity: name, message: `Invalid displayField: ${name}; target entity is missing` })
      continue
    }
    const readers = Object.keys(schema.permissions).filter(role => schema.permissions[role][name]?.includes('read'))
    const readable = (key: string) => {
      const field = entity.fields[key] ?? (baseFields.includes(key) ? { type: 'string' } : undefined)
      return !!field && field.type !== 'ref' && (readers.length ? readers.some(role => {
        const policy = schema.policies?.[name]?.[role]
        // Public /schema exposes policy presence only. Its true value may hide
        // an explicit sensitive-field allowlist already checked by defineInstance.
        if (policy === true) return true
        const allow = typeof policy === 'object' ? policy.fields : undefined
        return (!allow || allow.includes(key)) && (!field.sensitive || ['owner', 'administrator'].includes(role) || !!allow?.includes(key))
      }) : !field.sensitive)
    }
    if (entity.displayField && readable(entity.displayField)) continue
    const suggestion = suggestedDisplayField(entity, readable) ?? Object.keys(entity.fields).find(readable) ?? baseFields.find(readable)
    const suggestedChange = suggestion ? { kind: 'set_display_field' as const, entity: name, displayField: suggestion } : undefined
    errors.push({ code: 'invalid_display_field', entity: name,
      message: `Invalid displayField: ${name}; set displayField${suggestion ? `: '${suggestion}'` : ''} to an existing readable field. Refs are not allowed. ${suggestedChange ? `MCP repair: propose_change with ${JSON.stringify(suggestedChange)}, then validate the proposal.` : 'Make a scalar field readable, then use propose_change with kind: set_display_field.'}`,
      ...(suggestedChange ? { suggestedChange } : {}),
    })
  }
  return errors
}
export function validateDisplayFields(schema: DisplaySchema) {
  const errors = displayFieldErrors(schema)
  if (errors.length) throw new DisplayFieldError(errors)
}
