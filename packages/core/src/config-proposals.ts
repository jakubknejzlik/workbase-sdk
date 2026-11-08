import { z } from 'zod'
import { baseFields, cloneInstanceConfig, defineInstance, type InstanceConfig } from './config'
import { plan } from './migrations/planner'
import { diffVersions, versionData } from './migrations/versions'
import type { ConfigPatch } from './config-proposal-contract'
export type { ConfigPatch, ConfigProposal } from './config-proposal-contract'

const identifier = z.string().max(63).regex(/^[a-z][a-z0-9_]*$/).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value))
/** Bounded additive operations; neither a model nor a browser supplies executable config. */
export const configPatchSchema = z.array(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('add_enum_filter'), entity: identifier, field: identifier, values: z.array(z.string().min(1).max(100)).min(1).max(30).refine(values => new Set(values).size === values.length) }),
  z.strictObject({ kind: z.literal('enable_calendar'), entity: identifier, startField: identifier }),
  z.strictObject({ kind: z.literal('add_list_column'), entity: identifier, field: identifier }),
])).min(1).max(10)
export interface ConfigProposer { propose(prompt: string, config: InstanceConfig): Promise<ConfigPatch> }
export const promptSchema = z.string().trim().min(1).max(2000)
const refuse = (message: string): never => { throw new Error(message) }

export class RuleConfigProposer implements ConfigProposer {
  async propose(raw: string, config: InstanceConfig): Promise<ConfigPatch> {
    const prompt = promptSchema.parse(raw).toLowerCase()
    if (/\b(delete|remove|drop|rename|replace|permission|role|sql|deploy)\b|sma[zž]|odstra[nň]/.test(prompt)) refuse('Only additive field, filter, calendar and list column changes are supported.')
    const tokens: string[] = prompt.match(/[a-z][a-z0-9_]*/g) ?? []
    const entities = Object.keys(config.entities)
    const matches = entities.filter(entity => tokens.includes(entity) || tokens.includes(entity.replace(/s$/, '')))
    const entity = matches.length === 1 ? matches[0] : entities.length === 1 && !matches.length ? entities[0] : refuse(`Name one entity: ${entities.join(', ')}`)
    const fields = config.entities[entity].fields
    if (/\bcalendar\b|kalend[aá][řr]/.test(prompt)) {
      const dates = Object.keys(fields).filter(field => fields[field].type === 'datetime')
      const explicitDate = prompt.match(/(?:using|field|pole)\s+([a-z][a-z0-9_]*)/)?.[1]
      if (explicitDate && !dates.includes(explicitDate)) refuse(`Unknown datetime field: ${explicitDate}`)
      const named = dates.filter(field => tokens.includes(field))
      const startField = named.length === 1 ? named[0] : dates.length === 1 ? dates[0] : refuse(`Name one datetime field on ${entity}: ${dates.join(', ') || 'none'}`)
      return [{ kind: 'enable_calendar', entity, startField }]
    }
    if (/\bcolumn\b|sloupec/.test(prompt)) {
      const named = Object.keys(fields).filter(field => tokens.includes(field))
      if (named.length !== 1) refuse('Name one existing field for the list column.')
      return [{ kind: 'add_list_column', entity, field: named[0] }]
    }
    if (/\bfilter\b|filtr/.test(prompt) && /\b(field|enum|status)\b|pole/.test(prompt)) {
      const field = prompt.match(/(?:add|přidej|pridej)\s+(?:an?\s+)?(?:enum\s+)?([a-z][a-z0-9_]*)\s+(?:enum\s+)?(?:field|pole)/)?.[1] ?? (/\bstatus\b/.test(prompt) ? 'status' : refuse('Name the enum field, for example: add status field with filter.'))
      const valuesText = prompt.match(/(?:values|hodnoty)\s*[:=]?\s*([a-z0-9_, -]+)$/)?.[1]
      const values = valuesText ? valuesText.split(',').map(value => value.trim()) : ['new', 'in_progress', 'done']
      return configPatchSchema.parse([{ kind: 'add_enum_filter', entity, field, values }])
    }
    return refuse('Supported requests: add status field with filter to <entity>; enable calendar on <entity> using <date_field>; add <field> column to <entity>.')
  }
}

/** Provider adapters receive a schema description and return JSON, never config source or SQL. */
export interface ConfigProposalProvider {
  complete(input: { prompt: string; config: Record<string, unknown>; patchSchema: unknown }): Promise<unknown>
}
export class LlmConfigProposer implements ConfigProposer {
  constructor(private provider: ConfigProposalProvider) {}
  async propose(prompt: string, config: InstanceConfig): Promise<ConfigPatch> {
    return configPatchSchema.parse(await this.provider.complete({ prompt: promptSchema.parse(prompt), config: versionData(config), patchSchema: z.toJSONSchema(configPatchSchema) }))
  }
}

export function prepareConfigProposal(config: InstanceConfig, rawPatch: unknown) {
  const patch = configPatchSchema.parse(rawPatch)
  const next = cloneInstanceConfig(config)
  for (const entity of Object.values(next.entities)) for (const field of Object.values(entity.fields)) delete field.renameFrom
  for (const operation of patch) {
    const entity = next.entities[operation.entity] ?? refuse(`Unknown entity: ${operation.entity}`)
    next.ui ??= { entities: {} }
    const display = next.ui.entities[operation.entity] ??= {}
    const list = display.list ??= {}
    if (operation.kind === 'add_enum_filter') {
      if (Object.hasOwn(entity.fields, operation.field) || baseFields.includes(operation.field)) refuse(`Field already exists or is reserved: ${operation.field}`)
      entity.fields[operation.field] = { type: 'enum', required: false, values: operation.values }
      list.filter = { ...list.filter, [operation.field]: 'enum' }
      // Header filters are available only for visible list columns.
      if (list.columns) list.columns = [...list.columns, operation.field]
      for (const form of Object.values(display.form ?? {})) form.fields = [...form.fields, operation.field]
    } else if (operation.kind === 'enable_calendar') {
      if (entity.fields[operation.startField]?.type !== 'datetime') refuse('Calendar requires an existing datetime field.')
      if (display.views?.length) refuse('A calendar is already configured.')
      display.views = [{ kind: 'calendar', startField: operation.startField }]
    } else {
      if (!Object.hasOwn(entity.fields, operation.field)) refuse(`Unknown field: ${operation.field}`)
      // Without configured columns the list already includes visible schema fields.
      const columns = list.columns ?? Object.keys(entity.fields).filter(field => !entity.fields[field].ui?.hidden)
      if (columns.includes(operation.field)) refuse('The list already includes this column.')
      list.columns = [...columns, operation.field]
    }
  }
  next.revision++
  const target = defineInstance(next)
  const migration = plan(config, target)
  if (migration.blocked.length || migration.destructive.length) refuse(`Plan refused: ${migration.blocked.join('; ')}`)
  return { target, patch, plan: migration, changes: diffVersions(versionData(config), versionData(target)) }
}
