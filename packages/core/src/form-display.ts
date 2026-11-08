import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { ConsoleEntityDisplay } from './console-contract'

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/)
const view = z.strictObject({ fields: z.array(identifier) })
/** Canonical serializable form contract, shared with explicit Console contributions. */
export const formDisplaySchema = z.strictObject({ create: view.optional(), edit: view.optional() })
export const formSectionsSchema = z.array(z.strictObject({ id: identifier, label: z.string().min(1), fields: z.array(identifier) }))

export function validateFormDisplay(name: string, entity: InstanceConfig['entities'][string], display: Pick<ConsoleEntityDisplay, 'form' | 'sections'>) {
  const known = (field: string) => Object.hasOwn(entity.fields, field) || !!entity.relations[field]?.through
  const check = (fields: string[]) => {
    const seen = new Set<string>()
    for (const field of fields) {
      if (!known(field)) throw new Error(`Unknown UI form field: ${name}.${field}`)
      if (seen.has(field)) throw new Error(`Duplicate UI form field: ${name}.${field}`)
      seen.add(field)
    }
  }
  const form = display.form === undefined ? undefined : formDisplaySchema.parse(display.form)
  for (const view of Object.values(form ?? {})) check(view.fields)
  if (form?.create) for (const [field, spec] of Object.entries(entity.fields)) {
    // Server defaults and server-owned fields need no create control.
    if (spec.required && !spec.readOnly && spec.default === undefined && (!form.create.fields.includes(field) || spec.ui?.hidden)) {
      throw new Error(`Required UI create field omitted: ${name}.${field}`)
    }
  }
  const sections = display.sections === undefined ? [] : formSectionsSchema.parse(display.sections)
  const ids = new Set<string>()
  check(sections.flatMap(section => section.fields))
  for (const section of sections) {
    if (ids.has(section.id)) throw new Error(`Duplicate UI form section: ${name}.${section.id}`)
    ids.add(section.id)
  }
}
