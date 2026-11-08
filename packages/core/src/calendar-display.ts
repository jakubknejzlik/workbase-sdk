import { z } from 'zod'
import type { InstanceConfig } from './config'

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/)
/** Alternative entity list presentations; filter presets remain list.views. */
export const calendarViewsSchema = z.array(z.strictObject({
  kind: z.literal('calendar'), startField: identifier,
  endField: identifier.optional(), titleField: identifier.optional(),
  titleFields: z.array(identifier).min(1).max(4).refine(fields => new Set(fields).size === fields.length).optional(),
  secondaryField: identifier.optional(),
})).max(1)
export type CalendarView = z.infer<typeof calendarViewsSchema>[number]
export function validateCalendarViews(config: InstanceConfig, entity: string, input: unknown) {
  if (input === undefined) return
  for (const view of calendarViewsSchema.parse(input)) {
    const definition = config.entities[entity]
    for (const field of [view.startField, view.endField].filter((field): field is string => !!field)) {
      if (definition.fields[field]?.type !== 'datetime' && !['created_at', 'updated_at'].includes(field)) throw new Error(`Invalid calendar date field: ${entity}.${field}`)
    }
    if (view.titleField && (!definition.fields[view.titleField] || definition.fields[view.titleField].type === 'ref')) throw new Error(`Invalid calendar title field: ${entity}.${view.titleField}`)
    if (view.titleField && view.titleFields) throw new Error(`Conflicting calendar title declarations: ${entity}`)
    for (const field of view.titleFields ?? []) if (!definition.fields[field]) throw new Error(`Invalid calendar title field: ${entity}.${field}`)
    if (view.secondaryField && (!definition.fields[view.secondaryField] || ['ref', 'json'].includes(definition.fields[view.secondaryField].type))) throw new Error(`Invalid calendar secondary field: ${entity}.${view.secondaryField}`)
    if (view.endField === view.startField) throw new Error(`Duplicate calendar date field: ${entity}.${view.startField}`)
  }
}
