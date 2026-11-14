import { z } from 'zod'
import type { InstanceConfig } from './config'

// Declarative model/input builders shared by runtime validation and build tools.
export const baseFields = ['id', 'organization_id', 'created_at', 'updated_at', 'version']
export function bodyValidator(entity: InstanceConfig['entities'][string], partial = false) {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, f] of Object.entries(entity.fields)) {
    if (f.readOnly || f.computed) continue
    let v: z.ZodType
    switch (f.type) {
      case 'int': v = z.number().int().min(f.min ?? Number.MIN_SAFE_INTEGER); break
      case 'float': v = z.number().min(f.min ?? -Number.MAX_VALUE); break
      case 'bool': v = z.boolean(); break
      case 'datetime': v = z.iso.datetime(); break
      case 'enum': v = z.enum(f.values as [string, ...string[]]); break
      default: v = z.string().min(1).max(f.type === 'text' ? 100000 : 2000)
    }
    if (!f.required) v = v.nullable()
    if (!partial && f.default !== undefined) v = v.default(f.default)
    else if (partial || !f.required) v = v.optional()
    shape[name] = v
  }
  return z.strictObject(shape)
}
