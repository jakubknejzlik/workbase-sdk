import { z } from 'zod'
import type { RegistrySchema } from './schema'

/** Zod's JSON Schema reader lacks conditionals. Evaluate their branches against
 * the complete input and retain field paths so the production form shows errors. */
export function formValidator(schema: RegistrySchema): z.ZodType {
  const { allOf, if: condition, then: consequent, else: alternate, ...base } = schema
  const validator = z.fromJSONSchema(base as any)
  const constraints = (allOf ?? []).map((child: RegistrySchema) => formValidator(child))
  const predicate = condition === undefined ? undefined : formValidator(condition)
  const yes = consequent === undefined ? undefined : formValidator(consequent)
  const no = alternate === undefined ? undefined : formValidator(alternate)
  return validator.superRefine((data, ctx) => {
    const branch = predicate ? predicate.safeParse(data).success ? yes : no : undefined
    for (const constraint of [...constraints, ...(branch ? [branch] : [])]) {
      const result = constraint.safeParse(data)
      if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue)
    }
  })
}
