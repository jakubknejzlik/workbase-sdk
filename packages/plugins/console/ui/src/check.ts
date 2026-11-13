import { createHash } from 'node:crypto'
import { z } from 'zod'
import { buildPath, type Page, type Node, type Target } from './index'
import { assertChecked, SourceError, type Sources, type Entry } from './sources'
export { checkSources, routePath, SourceError } from './sources'
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
const title = z.string().regex(/^[\w-]+(?:\.[\w-]+)+$/)
const paramSpec = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('id'), entity: id }),
  z.strictObject({ kind: z.literal('string'), default: z.string().optional() }),
  z.strictObject({ kind: z.literal('int'), min: z.number().int().optional(), default: z.number().int().optional() }).refine(s => s.default === undefined || s.min === undefined || s.default >= s.min),
])
const params = z.record(id, paramSpec)
const binding = z.strictObject({ kind: z.enum(['one', 'list']), entity: id, bind: z.record(id, z.strictObject({ kind: z.literal('param'), name: id })) })
const node: z.ZodType<Node> = z.lazy(() => z.union([
  id,
  z.strictObject({ kind: z.enum(['section', 'row', 'columns', 'tabs', 'tab']), title: title.optional(), children: z.array(node) }),
  z.strictObject({ kind: z.literal('slot'), id, props: z.record(id, z.union([z.string(), z.boolean()])) }),
]))
const pageSchema = z.strictObject({
  kind: z.enum(['page', 'customPage']), title, params, search: params, data: z.record(id, binding), layout: z.array(node), uses: z.array(z.string()),
  entity: id.optional(), mode: z.enum(['list', 'detail', 'create', 'edit']).optional(),
})
const targetSchema = z.strictObject({ entity: id, mode: z.enum(['list', 'detail', 'edit']) })
const navSchema = z.array(z.strictObject({ title, target: targetSchema }))
const propSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('field'), type: z.string() }),
  z.strictObject({ kind: z.literal('boolean'), default: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('when') }),
])
const slotsSchema = z.record(id, z.strictObject({ contexts: z.array(z.enum(['record', 'form', 'row'])).min(1), props: z.record(id, propSchema) }))
export type Schema = Record<string, { fields: Record<string, { type: string; userLink?: boolean }> }>
export type ResolvedLink = { to: string; bind: Record<string, string> }
export type Manifest = { version: 1; configHash: string; routes: (Omit<Page, 'component'> & { source: string; path: string; links: Partial<Record<'list' | 'detail' | 'edit', ResolvedLink>> })[]; nav: { title: string; link: ResolvedLink }[]; slots: z.infer<typeof slotsSchema> }
/** Reject values JSON would silently coerce, drop, invoke, or reorder semantically. */
function jsonData(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return
  if (!value || typeof value !== 'object' || seen.has(value) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected JSON data equal to its round-trip')
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (key === '__proto__') throw new Error(`Forbidden manifest key: ${key}`)
    if (Array.isArray(value) && key === 'length') continue
    if (Array.isArray(value) && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) throw new Error('Expected JSON array indices')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Expected plain JSON properties')
    jsonData(descriptor.value, seen)
  }
  if (JSON.stringify(value) !== JSON.stringify(JSON.parse(JSON.stringify(value)))) throw new Error('Expected JSON round-trip')
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Error('Expected dense JSON array')
  seen.delete(value)
}
function stripComponent(value: unknown, required: boolean) {
  if (!value || typeof value !== 'object') throw new Error('Expected a declaration object')
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected a plain declaration object')
  const descriptor = Object.getOwnPropertyDescriptor(value, 'component')
  if (descriptor && !required) throw new Error('component is only allowed on custom pages and slots')
  if (descriptor && (!('value' in descriptor) || typeof descriptor.value !== 'function') || required && !descriptor) throw new Error('component must be a function')
  const clone = Object.create(null, Object.getOwnPropertyDescriptors(value))
  delete clone.component
  jsonData(clone)
  return clone
}
/** Keep identifier records as own data, including constructor and prototype. */
function nullObjects<T>(value: T): T {
  if (Array.isArray(value)) return value.map(nullObjects) as T
  if (value && typeof value === 'object') {
    const result = Object.create(null)
    for (const [key, item] of Object.entries(value)) result[key] = nullObjects(item)
    return result
  }
  return value
}
function strictParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.parse(input)
  if (canonicalJSON(parsed) !== canonicalJSON(input)) throw new Error('Manifest parse dropped or changed an own key')
  return nullObjects(parsed)
}
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
export const manifestHash = (manifest: Manifest): string => createHash('sha256').update(canonicalJSON(manifest)).digest('hex')
export function normalise(sources: Sources, values: Record<string, unknown>, schema: Schema, configHash: string): Manifest {
  assertChecked(sources)
  const fail = (entry: Entry, message: string): never => { throw new SourceError(entry.location, message) }
  function at<T>(entry: Entry, fn: () => T): T { try { return fn() } catch (error) { return fail(entry, error instanceof Error ? error.message : String(error)) } }
  const slotEntry = sources.entries.find(e => e.helper === 'defineSlots')
  const slots = slotEntry ? at(slotEntry, () => {
    const raw = values[slotEntry.source]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected slots object')
    // Check the registry itself before reading its values, excluding only leaf components.
    if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('Expected a plain slots object')
    const clean = Object.create(null)
    for (const key of Reflect.ownKeys(raw)) {
      if (key === '__proto__') throw new Error(`Forbidden manifest key: ${key}`)
      const d = Object.getOwnPropertyDescriptor(raw, key)!
      if (typeof key !== 'string' || !d.enumerable || !('value' in d)) throw new Error('Expected JSON slot registry')
      Object.defineProperty(clean, key, { value: stripComponent(d.value, true), enumerable: true })
    }
    jsonData(clean)
    return strictParse(slotsSchema, clean)
  }) : Object.create(null) as Manifest['slots']
  const paths = new Map<string, Entry>()
  const routes = sources.entries.filter(e => e.path !== undefined).map(entry => at(entry, () => {
    const raw = values[entry.source]
    const page = strictParse(pageSchema, stripComponent(raw, entry.helper === 'customPage'))
    if ((page.kind === 'customPage') !== (entry.helper === 'customPage')) throw new Error('Page kind does not match SDK construction')
    const path = entry.path!, collision = path.toLowerCase().replace(/\/+$/, '').replace(/\$[^/]+/g, '$param')
    const previous = paths.get(collision)
    if (previous) throw new Error(`Route collision: ${path}; first declared at ${previous.location.file}:${previous.location.line}:${previous.location.column}`)
    paths.set(collision, entry)
    buildPath(path, Object.fromEntries(Object.keys(page.params).map(key => [key, 'probe'])))
    if (Object.keys(page.params).some(key => Object.hasOwn(page.search, key))) throw new Error('Duplicate path/search param')
    for (const spec of [...Object.values(page.params), ...Object.values(page.search)]) if (spec.kind === 'id' && !Object.hasOwn(schema, spec.entity)) throw new Error(`Unknown param entity ${spec.entity}`)
    if (page.entity && !Object.hasOwn(schema, page.entity)) throw new Error(`Unknown entity ${page.entity}`)
    for (const use of page.uses) {
      const [entity, field, extra] = use.split('.')
      if (extra || !Object.hasOwn(schema, entity) || !Object.hasOwn(schema[entity].fields, field)) throw new Error(`Unknown uses ${use}`)
    }
    for (const binding of Object.values(page.data)) {
      if (!Object.hasOwn(schema, binding.entity)) throw new Error(`Unknown data entity ${binding.entity}`)
      for (const ref of Object.values(binding.bind)) if (!Object.hasOwn(page.params, ref.name) && !Object.hasOwn(page.search, ref.name)) throw new Error(`Unknown binding param ${ref.name}`)
    }
    const field = (name: string, type?: string) => {
      const fields = page.entity ? schema[page.entity].fields : undefined
      const spec = fields && Object.hasOwn(fields, name) ? fields[name] : undefined
      if (!spec || type && (type === 'userLink' ? !spec.userLink : spec.type !== type)) throw new Error(`Unknown or wrong field ${name}`)
    }
    function walk(nodes: Node[]) {
      for (const node of nodes) {
        if (typeof node === 'string') { field(node); continue }
        if (node.kind !== 'slot') { walk(node.children); continue }
        const definition = slots[node.id]
        if (!definition) throw new Error(`Unknown slot ${node.id}`)
        const context = page.mode === 'list' ? 'row' : ['edit', 'create'].includes(page.mode ?? '') ? 'form' : 'record'
        if (!definition.contexts.includes(context)) throw new Error(`Unknown slot context ${context}`)
        for (const key of Object.keys(node.props)) if (!Object.hasOwn(definition.props, key)) throw new Error(`Unknown slot prop ${key}`)
        for (const [key, spec] of Object.entries(definition.props)) {
          const value = node.props[key] ?? ('default' in spec ? spec.default : undefined)
          if (spec.kind === 'field') { if (typeof value !== 'string') throw new Error(`Invalid field prop ${key}`); field(value, spec.type) }
          if (spec.kind === 'boolean' && typeof value !== 'boolean' || spec.kind === 'when' && !['create', 'edit'].includes(String(value))) throw new Error(`Invalid slot prop ${key}`)
        }
      }
    }
    walk(page.layout)
    return { ...page, source: entry.source, path, links: {} } as Manifest['routes'][number]
  })).sort((a, b) => compare(a.path, b.path))
  function resolveLink(target: Target): ResolvedLink {
    const matches = routes.filter(route => route.entity === target.entity && route.mode === target.mode)
    if (matches.length !== 1) throw new Error(`Missing or ambiguous page: ${target.entity}.${target.mode}`)
    const route = matches[0], names = Object.keys(route.params)
    if (names.length > 1 || target.mode === 'list' && names.length || target.mode !== 'list' && (names.length !== 1 || route.params[names[0]].kind !== 'id')) throw new Error('Cannot bind entity page params')
    const bind = Object.fromEntries(names.map(name => [name, 'record.id']))
    buildPath(route.path, Object.fromEntries(names.map(name => [name, 'probe'])))
    return { to: route.path, bind }
  }
  for (const route of routes) if (route.entity) for (const mode of ['list', 'detail', 'edit'] as const) if (routes.some(r => r.entity === route.entity && r.mode === mode)) {
    const entry = sources.entries.find(e => e.source === route.source)!
    route.links[mode] = at(entry, () => resolveLink({ entity: route.entity!, mode }))
  }
  const navEntry = sources.entries.find(e => e.helper === 'defineNav')
  const nav = navEntry ? at(navEntry, () => {
    jsonData(values[navEntry.source])
    return strictParse(navSchema, values[navEntry.source]).map(item => ({ title: item.title, link: resolveLink(item.target) })).sort((a, b) => compare(a.link.to, b.link.to) || compare(a.title, b.title))
  }) : []
  return nullObjects({ version: 1, configHash, routes, nav, slots })
}
