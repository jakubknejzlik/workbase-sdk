import type { ConsoleInputSchema } from './console-contract'

const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const children = new Set(['items', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties',
  'unevaluatedItems', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contentSchema'])
const references = new Set(['$ref', '$dynamicRef', '$recursiveRef'])
const literals = new Set(['default', 'const', 'enum', 'description', 'title', 'pattern'])
// Unknown annotations/extensions never pass through. Values in literal data are not schema nodes.
const strings = new Set(['$schema', '$id', '$anchor', '$dynamicAnchor', 'referenceEntity'])
const numbers = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'minContains', 'maxContains', 'minProperties', 'maxProperties'])
const booleans = new Set(['$recursiveAnchor', 'uniqueItems', 'readOnly', 'writeOnly', 'deprecated', 'sensitive'])
const formats = new Set(['date-time', 'time', 'date', 'duration', 'email', 'idn-email', 'hostname', 'idn-hostname',
  'ipv4', 'ipv6', 'uri', 'uri-reference', 'iri', 'iri-reference', 'uuid', 'uri-template', 'json-pointer', 'relative-json-pointer', 'regex'])
const schemaTypes = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer'])
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
function annotation(key: string, value: unknown): boolean {
  return key === 'format' && typeof value === 'string' && formats.has(value) || strings.has(key) && typeof value === 'string' || numbers.has(key) && typeof value === 'number' && Number.isFinite(value)
    || booleans.has(key) && typeof value === 'boolean' || key === 'type' && (typeof value === 'string' ? schemaTypes.has(value) : stringArray(value) && value.every(type => schemaTypes.has(type)))
    || key === 'required' && stringArray(value) || key === 'dependentRequired' && record(value) && Object.values(value).every(stringArray)
}
const uiKeys = new Set(['kind', 'label', 'labelKey', 'placeholder', 'help', 'span', 'section', 'hidden', 'format'])
const schemaNode = (value: unknown) => typeof value === 'boolean' || record(value)
const schemaChild = (value: unknown) => schemaNode(value) || Array.isArray(value) && value.every(schemaNode)

/** Resolve and analyze the schema graph once. Reverse reachability is O(nodes + edges),
 * including shared aliases and cycles; unresolved references seed redaction too. */
export function consoleInputSchema(value: unknown, allowed: (node: Record<string, unknown>) => boolean): ConsoleInputSchema {
  const nodes = new Set<Record<string, unknown>>()
  const edges = new Map<Record<string, unknown>, Set<Record<string, unknown>>>()
  const anchors = new Map<string, Set<Record<string, unknown>>>()
  function collect(value: unknown) {
    if (Array.isArray(value)) { value.forEach(collect); return }
    if (!record(value) || nodes.has(value)) return
    nodes.add(value)
    const nested = new Set<Record<string, unknown>>()
    function add(child: unknown) {
      if (Array.isArray(child)) child.forEach(add)
      else if (record(child)) { nested.add(child); collect(child) }
    }
    for (const [key, item] of Object.entries(value)) {
      if (maps.has(key) && record(item)) Object.values(item).forEach(add)
      else if (children.has(key)) add(item)
    }
    edges.set(value, nested)
    for (const key of ['$anchor', '$dynamicAnchor']) if (typeof value[key] === 'string') {
      const anchor = value[key]
      if (!anchors.has(anchor)) anchors.set(anchor, new Set())
      anchors.get(anchor)!.add(value)
    }
  }
  collect(value)
  function targets(reference: unknown): Record<string, unknown>[] {
    if (typeof reference !== 'string') return []
    let ref = reference
    if (!ref.startsWith('#')) {
      const base = record(value) && typeof value.$id === 'string' ? value.$id.split('#')[0] : undefined
      const hash = ref.indexOf('#')
      if (!base || (hash < 0 ? ref : ref.slice(0, hash)) !== base) return []
      ref = hash < 0 ? '#' : ref.slice(hash)
    }
    let fragment: string
    try { fragment = decodeURIComponent(ref.slice(1)) } catch { return [] }
    let result = value
    if (fragment && !fragment.startsWith('/')) return [...anchors.get(fragment) ?? []]
    if (fragment) for (const part of fragment.slice(1).split('/')) {
      if (/~[^01]|~$/.test(part)) return []
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
      if (!record(result) && !Array.isArray(result) || !Object.hasOwn(result as object, key)) return []
      result = (result as Record<string, unknown>)[key]
    }
    return record(result) && nodes.has(result) ? [result] : []
  }
  const privateNodes = new Set<Record<string, unknown>>()
  const unresolved = new Set<Record<string, unknown>>()
  for (const node of nodes) {
    if (!allowed(node)) privateNodes.add(node)
    for (const [key, item] of Object.entries(node)) {
      if (maps.has(key) && (!record(item) || !Object.values(item).every(schemaNode))
        || children.has(key) && !schemaChild(item)) unresolved.add(node)
      if (!maps.has(key) && !children.has(key) && !references.has(key) && !literals.has(key)
        && !annotation(key, item) && key !== 'examples' && key !== 'x-ui') unresolved.add(node)
    }
    for (const key of references) if (Object.hasOwn(node, key)) {
      // Keep every possible local target in the graph, even for ambiguous or
      // dynamic references: uncertainty must redact candidate definitions too.
      const candidates = targets(node[key])
      candidates.forEach(target => edges.get(node)!.add(target))
      if (key !== '$ref' || candidates.length !== 1) unresolved.add(node)
      // With no known target, alias/context propagation cannot be proven complete.
      // Redact literals throughout this input document rather than trusting a
      // definition that an unsupported reference spelling might still alias.
      if (!candidates.length && record(value)) unresolved.add(value)
    }
    // A nested $id changes reference scope. Fail closed rather than interpreting
    // its descendants against the document root.
    if (node !== value && node.$id !== undefined) unresolved.add(node)
  }
  function reach(seeds: Set<Record<string, unknown>>, graph: Map<Record<string, unknown>, Set<Record<string, unknown>>>) {
    const reached = new Set(seeds)
    const queue = [...seeds]
    for (let i = 0; i < queue.length; i++) for (const child of graph.get(queue[i]) ?? []) if (!reached.has(child)) {
      reached.add(child); queue.push(child)
    }
    return reached
  }
  // Sensitive context propagates into referenced definitions in every use.
  const tainted = reach(new Set([...privateNodes, ...unresolved]), edges)
  const reverse = new Map<Record<string, unknown>, Set<Record<string, unknown>>>()
  for (const [node, targets] of edges) for (const child of targets) {
    if (!reverse.has(child)) reverse.set(child, new Set())
    reverse.get(child)!.add(node)
  }
  const unsafe = reach(tainted, reverse)
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit)
    if (!record(value)) return value
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (maps.has(key) && record(item)) result[key] = Object.fromEntries(Object.entries(item).filter(([, schema]) => schemaNode(schema)).map(([name, schema]) => [name, visit(schema)]))
      else if (children.has(key) && schemaChild(item)) result[key] = visit(item)
      else if (references.has(key)) { if (key === '$ref' && targets(item).length === 1) result[key] = item }
      else if (literals.has(key)) {
        if (!unsafe.has(value) && (!['description', 'title', 'pattern'].includes(key) || typeof item === 'string') && (key !== 'enum' || Array.isArray(item))) result[key] = item
      } else if (annotation(key, item) && (key !== 'referenceEntity' || allowed(value))) result[key] = item
      else if (key === 'x-ui' && !unsafe.has(value) && record(item)) {
        result[key] = Object.fromEntries(Object.entries(item).filter(([key, hint]) => uiKeys.has(key) && ['string', 'boolean', 'number'].includes(typeof hint)
          || key === 'fieldOrder' && stringArray(hint) && hint.every(field => record(value.properties) && Object.hasOwn(value.properties, field))))
      }
    }
    return result
  }
  return visit(value) as ConsoleInputSchema
}
