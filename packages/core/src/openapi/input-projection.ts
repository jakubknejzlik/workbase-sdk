import { z } from 'zod'
import type { Schema } from './public-paths'

type ZodSchema = z.core.$ZodType
// Only JSON Schema vocabulary used by the public projection is eligible for disclosure.
// Schema-map keys (including user fields named "default") are data, not vocabulary.
const structural = new Set(['$ref', '$defs', 'type', 'properties', 'required', 'items', 'prefixItems', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not'])
const constraints = new Set(['enum', 'format', 'pattern', 'patternProperties', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'propertyNames', 'contains', 'minContains', 'maxContains', 'dependentRequired', 'dependentSchemas'])
const annotations = ['title', 'description', 'sensitive', 'readOnly', 'referenceEntity'] as const

/** Follow exactly the output-facing wrapper chain used by /schema, without parsing
 * values or reading defaultValue getters. Pipelines' input annotations are private. */
function outputChain(schema: ZodSchema): ZodSchema[] {
  const chain: ZodSchema[] = [], seen = new Set<ZodSchema>()
  while (!seen.has(schema)) {
    seen.add(schema)
    chain.push(schema)
    const def = schema._zod.def as any
    const next = def.type === 'pipe' ? def.out : def.innerType ?? (def.type === 'lazy' ? (schema as z.core.$ZodLazy)._zod.innerType : undefined)
    if (!next) break
    schema = next
  }
  return chain
}
function sensitivity(schema: ZodSchema, seen = new Set<ZodSchema>()): boolean {
  if (seen.has(schema)) return false
  seen.add(schema)
  if (z.globalRegistry.get(schema)?.sensitive === true) return true
  const def = schema._zod.def as any
  return def.type === 'pipe' ? sensitivity(def.in, seen) || sensitivity(def.out, seen)
    : def.innerType ? sensitivity(def.innerType, seen) : def.type === 'lazy' ? sensitivity((schema as z.core.$ZodLazy)._zod.innerType!, seen) : false
}

/** Build a default-free graph before Zod can evaluate default/prefault/catch
 * factories. Input syntax is retained; pipeline-only values and annotations are
 * omitted, and object keys must also exist on the public output side. This may
 * deliberately widen a pipeline's scalar constraints rather than disclose them.
 * /schema continues to use its original output conversion and sanitizer. */
export function publicInputSchema(input: z.ZodType): Schema {
  const metadata = z.registry<Record<string, any>>()
  const contexts = new WeakMap<ZodSchema, { boundary: ZodSchema; sensitive: boolean; restricted: boolean; schema: ZodSchema }[]>()
  const restrictedSchemas = new WeakSet<ZodSchema>()
  const undisclosed = z.unknown()
  function project(source: ZodSchema, boundary = source, inherited = false, restricted = false): ZodSchema {
    const sensitive = inherited || sensitivity(source) || sensitivity(boundary)
    const cached = contexts.get(source)?.find(entry => entry.boundary === boundary && entry.sensitive === sensitive && entry.restricted === restricted)
    if (cached) return cached.schema
    const def = source._zod.def as any
    const chain = outputChain(boundary), publicNode = chain.at(-1)!, publicDef = publicNode._zod.def as any
    // Copy descriptors so a ZodDefault's defaultValue accessor is never read.
    const descriptors = Object.getOwnPropertyDescriptors(def)
    const copy: any = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (['defaultValue', 'catchValue', 'shape', 'getter', '_cachedInner'].includes(key)) continue
      Object.defineProperty(copy, key, descriptor)
    }
    if (def.type === 'default' || def.type === 'prefault') copy.defaultValue = null
    if (def.type === 'catch') copy.catchValue = () => undefined
    // Resolve structural getters lazily, after the clone is memoized (recursive objects).
    if (def.type === 'object') Object.defineProperty(copy, 'shape', { get: () => Object.fromEntries(Object.entries(def.shape).flatMap(([key, child]) => {
      const output = publicDef.type === 'object' ? publicDef.shape[key] : undefined
      return restricted && !output ? [] : [[key, project(child as ZodSchema, output ?? child as ZodSchema, sensitive, restricted)]]
    })), enumerable: true })
    if (def.type === 'lazy') copy.getter = () => project((source as z.core.$ZodLazy)._zod.innerType!, publicNode, sensitive, restricted)
    let schema: ZodSchema
    // Broadening private enum/literal values also prevents record/union processors
    // from deriving public key inventories from the private _zod.values set.
    if (restricted && ['enum', 'literal'].includes(def.type)) {
      const values = def.type === 'enum' ? Object.values(def.entries) : def.values
      const types = [...new Set(values.map((value: unknown) => value === null ? 'null' : typeof value))]
      const primitives: Record<string, z.ZodType> = { string: z.string(), number: z.number(), boolean: z.boolean(), null: z.null() }
      schema = types.length === 1 ? primitives[types[0] as string] ?? z.unknown() : z.unknown()
    } else schema = z.core.clone(source, copy)
    const entries = contexts.get(source) ?? []
    entries.push({ boundary, sensitive, restricted, schema })
    contexts.set(source, entries)
    if (restricted) restrictedSchemas.add(schema)
    const meta: Record<string, any> = {}
    for (const node of [...chain].reverse()) {
      const published = z.globalRegistry.get(node)
      for (const key of annotations) if (published?.[key] !== undefined && !(sensitive && key === 'description')) meta[key] = published[key]
    }
    metadata.add(schema, meta)
    // The constructor retains `copy` by reference. Replace child schemas only
    // after memoization; lazy getters above close over this same projection.
    const child = (value: ZodSchema, output?: ZodSchema) => project(value, output ?? (restricted ? undisclosed : value), sensitive, restricted)
    if (def.type === 'pipe') {
      const input = def.in._zod.def.type === 'transform' ? def.out : def.in
      copy.in = project(input, boundary, sensitive, true)
      copy.out = z.unknown() // io:input never visits the executable output transform.
    } else {
      for (const key of ['innerType', 'element', 'keyType', 'valueType', 'left', 'right', 'rest', 'catchall']) if (def[key]) copy[key] = child(def[key], publicDef[key])
      for (const key of ['options', 'items']) if (Array.isArray(def[key])) copy[key] = def[key].map((value: ZodSchema, index: number) => child(value, publicDef[key]?.[index]))
    }
    return schema
  }
  const result = z.toJSONSchema(project(input), { io: 'input', metadata, override({ zodSchema, jsonSchema }) {
    const restricted = restrictedSchemas.has(zodSchema)
    for (const key of Object.keys(jsonSchema)) if (!structural.has(key) && !annotations.includes(key as any) && !(constraints.has(key) && !restricted)) delete (jsonSchema as any)[key]
  } }) as Schema
  delete result.$schema
  return result
}
