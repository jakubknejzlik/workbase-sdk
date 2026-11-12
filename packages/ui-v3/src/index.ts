import type { ComponentType, ReactNode } from 'react'

export type Field = { type: string; userLink?: boolean; entity?: string; values?: readonly string[]; required?: boolean; readOnly?: boolean; default?: unknown }
export type Schema = Record<string, {
  displayField?: string
  singular: string
  fields: Record<string, Field>
  relations: Record<string, { entity: string; field: string; many?: boolean }>
}>
export type FieldName<S extends Schema, E extends keyof S> = keyof S[E]['fields'] & string
export type Span = number | Partial<Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', number>>
export type Node<F extends string = string> = F | {
  kind: 'header' | 'section' | 'row' | 'columns' | 'tabs' | 'tab' | 'slot' | 'related' | 'action'
  id?: string
  title?: string
  children?: Node<F>[]
  cells?: { children: Node<F>[]; span: Span }[]
  props?: Record<string, unknown>
  columns?: string[]
}
declare const layoutSchema: unique symbol
export type Layout<F extends string = string, S extends Schema = Schema, E extends string = string> = {
  readonly [layoutSchema]?: S
  readonly entity: E
  kind: 'layout' | 'list'
  nodes: Node<F>[]
  omit: F[]
  orderBy?: F
  search?: F[]
  source?: string
}
export type Param<T = unknown> = { kind: 'field' | 'boolean' | 'when'; type?: string; default?: T; parse(value: unknown): T }
type Shape = Record<string, Param>
type Parsed<P extends Shape> = { [K in keyof P]: ReturnType<P[K]['parse']> }
type Selected<P extends Shape> = { [K in keyof P]: P[K] extends Param<infer V> & { kind: 'field' } ? V : never }[keyof P] & string
export type SlotDefinition<P extends Shape = Shape> = {
  modes: ('record' | 'form' | 'row')[]
  props: P
  render(context: { record: Partial<Record<Selected<P>, unknown>>; props: Parsed<P> }): ReactNode
}
export type Slots = Record<string, SlotDefinition<any>>
export function defineSlots<const R extends Slots>(registry: R): R { return registry }
export const p = {
  boolean: ({ default: fallback = false } = {}): Param<boolean> => ({ kind: 'boolean', default: fallback, parse(value) {
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new Error('Expected boolean slot prop')
    return value
  } }),
  when: (): Param<'create' | 'edit'> => ({ kind: 'when', parse(value) {
    if (value !== 'create' && value !== 'edit') throw new Error('Expected create or edit')
    return value
  } }),
}

// Binding schema/entity once keeps contextual field typing through nested helpers.
export function defineUI<const S extends Schema, E extends keyof S & string, R extends Slots>(schema: S, entity: E, slots: R) {
  type F = FieldName<S, E>
  const group = (kind: 'section' | 'tab', id: string, children: Node<F>[], title?: string): Node<F> => ({ kind, id, title, children })
  return {
    schema, entity, slots,
    field<const T extends 'string' | 'userLink'>(type: T) {
      type Match = { [K in F]: T extends 'userLink' ? S[E]['fields'][K] extends { userLink: true } ? K : never : S[E]['fields'][K] extends { type: T } ? K : never }[F]
      return { kind: 'field' as const, type, parse(value: unknown): Match {
        if (typeof value !== 'string' || !(value in schema[entity].fields)) throw new Error(`Unknown field ${String(value)}`)
        const field = schema[entity].fields[value]
        if (type === 'userLink' ? !field.userLink : field.type !== type) throw new Error(`Wrong field type: ${value}`)
        return value as Match
      } }
    },
    layout(nodes: Node<F>[], options: { omit?: F[]; source?: string } = {}): Layout<F, S, E> { return { entity, kind: 'layout', nodes, omit: [], ...options } },
    list(nodes: Node<F>[], options: { orderBy?: F; search?: F[]; source?: string } = {}): Layout<F, S, E> { return { entity, kind: 'list', nodes, omit: [], ...options } },
    section: (id: string, children: Node<F>[], title?: string) => group('section', id, children, title),
    tab: (id: string, children: Node<F>[], title?: string) => group('tab', id, children, title),
    header: (options: { badges: Node<F>[] }): Node<F> => ({ kind: 'header', children: options.badges }),
    row: (cells: [Node<F>, Span][]): Node<F> => ({ kind: 'row', cells: cells.map(([node, span]) => ({ children: [node], span })) }),
    columns: (cells: [Node<F>[], Span][]): Node<F> => ({ kind: 'columns', cells: cells.map(([children, span]) => ({ children, span })) }),
    tabs: (children: Node<F>[]): Node<F> => ({ kind: 'tabs', children }),
    slot<K extends keyof R & string>(id: K, props: Parsed<R[K]['props']>): Node<F> { return { kind: 'slot', id, props } },
    related<K extends keyof S[E]['relations'] & string>(id: K, opts: { columns: (keyof S[S[E]['relations'][K]['entity']]['fields'] & string)[] }): Node<F> { return { kind: 'related', id, ...opts } },
    action: (id: string): Node<F> => ({ kind: 'action', id }),
  }
}

export function defineSlot<const P extends Shape>(definition: SlotDefinition<P>): SlotDefinition<P> { return definition }
const brand = Symbol.for('@workbasehq/ui-v3/page')
export type Page<S extends Schema = Schema, E extends keyof S & string = keyof S & string> = {
  readonly [brand]: true
  kind: 'page' | 'customPage'
  title: string
  nav?: { icon: string }
  uses: string[]
  entity?: E
  mode?: 'list' | 'detail' | 'create' | 'edit'
  layout?: Layout<FieldName<S, E>, S, E>
  component?: ComponentType<any>
}
type PageInput<S extends Schema, E extends keyof S & string> = Omit<Page<S, E>, typeof brand | 'kind' | 'uses' | 'layout'> & { uses?: string[]; layout?: Layout<FieldName<S, E>, S, NoInfer<E>> }
export function page<S extends Schema, const E extends keyof S & string>(input: PageInput<S, E>): Page<S, E> { return { ...input, uses: input.uses ?? [], kind: 'page', [brand]: true } }
export function customPage(input: PageInput<Schema, string> & { uses: string[]; component: ComponentType<any> }): Page { return { ...page(input), kind: 'customPage' } }
type EntityOptions = { title: string; uses?: string[] }
const entityPage = <S extends Schema, E extends keyof S & string>(mode: Page['mode'], entity: E, layout: Layout<FieldName<S, E>, S, NoInfer<E>>, options: EntityOptions): Page<S, E> => page<S, E>({ ...options, entity, layout, mode })
export const entityListPage = <S extends Schema, E extends keyof S & string>(entity: E, layout: Layout<FieldName<S, E>, S, NoInfer<E>>, options: EntityOptions) => entityPage<S, E>('list', entity, layout, options)
export const entityDetailPage = <S extends Schema, E extends keyof S & string>(entity: E, layout: Layout<FieldName<S, E>, S, NoInfer<E>>, options: EntityOptions) => entityPage<S, E>('detail', entity, layout, options)
export const entityCreatePage = <S extends Schema, E extends keyof S & string>(entity: E, layout: Layout<FieldName<S, E>, S, NoInfer<E>>, options: EntityOptions) => entityPage<S, E>('create', entity, layout, options)
export const entityEditPage = <S extends Schema, E extends keyof S & string>(entity: E, layout: Layout<FieldName<S, E>, S, NoInfer<E>>, options: EntityOptions) => entityPage<S, E>('edit', entity, layout, options)

export const breakpoints = ['xs', 'sm', 'md', 'lg', 'xl'] as const
export function resolvedSpans(span: Span): number[] {
  if (!span || typeof span !== 'number' && (Array.isArray(span) || Object.keys(span).some(key => !breakpoints.includes(key as typeof breakpoints[number])))) throw new Error('Invalid responsive span')
  const values = typeof span === 'number' ? [span] : Object.values(span)
  if (!values.length || values.some(value => !Number.isInteger(value) || value < 1 || value > 12)) throw new Error('Span must be 1..12')
  let previous = 12
  return breakpoints.map(key => previous = typeof span === 'number' ? span : span[key] ?? previous)
}

export function slotInput(definition: SlotDefinition, input: Record<string, unknown>, record: Record<string, unknown>) {
  for (const key of Object.keys(input)) if (!(key in definition.props)) throw new Error(`Unknown slot prop ${key}`)
  const props: Record<string, unknown> = {}
  const selected: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(definition.props)) {
    props[key] = spec.parse(input[key])
    if (spec.kind === 'field') selected[String(props[key])] = record[String(props[key])]
  }
  return { props, record: selected }
}

export function getManifest(routes: Record<string, unknown>, schema: Schema, slots: Slots) {
  const paths = new Set<string>()
  return Object.entries(routes).map(([source, value]) => {
    const fail = (message: string): never => { throw new Error(`${source}: ${message}`) }
    if (!value || typeof value !== 'object' || !(brand in value) || value[brand] !== true) fail('Expected SDK-branded page')
    const route = value as Page
    if (typeof route.title !== 'string' || !route.title.includes('.')) fail('Title must be an i18n key')
    if (!Array.isArray(route.uses)) fail('uses must be an array')
    if (route.kind === 'customPage' && typeof route.component !== 'function') fail('customPage needs a component')
    const path = routePath(source)
    const collisionKey = path.replace(/\$[^/]+/g, '$param')
    if (paths.has(collisionKey)) fail(`Route collision: ${path}`)
    paths.add(collisionKey)
    const uses = new Set<string>(route.uses)
    const checkUse = (use: string) => {
      const [name, field, extra] = use.split('.')
      const entity = schema[name] ?? Object.values(schema).find(e => e.singular === name)
      if (!entity || !field || extra || !(field in entity.fields)) fail(`Unknown uses field ${use}`)
    }
    for (const use of uses) checkUse(use)
    if (route.entity && !schema[route.entity]) fail(`Unknown entity ${route.entity}`)
    const entity = route.entity ? schema[route.entity] : undefined
    const placed = new Set<string>()
    const field = (name: string) => {
      if (!entity || !(name in entity.fields)) fail(`Unknown layout field ${name}`)
      placed.add(name)
      uses.add(`${entity!.singular}.${name}`)
    }
    function walk(nodes: Node[]) {
      if (!Array.isArray(nodes)) fail('Invalid layout children')
      for (const node of nodes) {
        if (typeof node === 'string') { field(node); continue }
        if (!node || !['header', 'section', 'row', 'columns', 'tabs', 'tab', 'slot', 'related', 'action'].includes(node.kind)) fail('Invalid layout node')
        if (node.kind === 'slot') {
          const definition = slots[node.id!]
          if (!definition) fail(`Unknown slot ${node.id}`)
          const mode = route.mode === 'list' ? 'row' : route.mode === 'create' || route.mode === 'edit' ? 'form' : 'record'
          if (!definition.modes.includes(mode)) fail(`Slot ${node.id} cannot receive ${mode}`)
          slotInput(definition, node.props ?? {}, {})
          for (const [key, spec] of Object.entries(definition.props as Shape)) if (spec.kind === 'field') {
            const name = String(node.props?.[key])
            field(name)
            const actual = entity!.fields[name]
            if (spec.type === 'userLink' ? !actual.userLink : actual.type !== spec.type) fail(`Wrong field type for slot ${node.id}.${key}`)
          }
        }
        if (node.kind === 'related') {
          const target = entity?.relations[node.id!]?.entity
          if (!target || !schema[target]) fail(`Unknown relation ${node.id}`)
          for (const name of node.columns ?? []) {
            if (!(name in schema[target!].fields)) fail(`Unknown related field ${name}`)
            uses.add(`${schema[target!].singular}.${name}`)
          }
        }
        if (node.kind === 'action') fail(`No command registry in this spike: ${node.id}`)
        if (node.children) walk(node.children)
        if (node.cells) {
          const spans = node.cells.map(cell => resolvedSpans(cell.span))
          for (const cell of node.cells) walk(cell.children)
          for (const [index, breakpoint] of breakpoints.entries()) {
            // Full-width cells explicitly start a new grid row. Partial cells on
            // each row must fit at every breakpoint, including inherited spans.
            let total = 0
            for (const cell of spans) {
              if (cell[index] === 12) { total = 0; continue }
              total += cell[index]
              if (total > 12) fail(`Columns exceed 12 at ${breakpoint}`)
            }
          }
        }
      }
    }
    if (route.layout) {
      if (route.layout.entity !== route.entity) fail('Layout entity does not match page entity')
      walk(route.layout.nodes)
      for (const name of route.layout.omit) if (!entity || !(name in entity.fields)) fail(`Unknown omitted field ${name}`)
      if (route.layout.orderBy) field(route.layout.orderBy)
      for (const name of route.layout.search ?? []) field(name)
      if (entity && route.layout.kind !== 'list') for (const name of Object.keys(entity.fields)) if (!placed.has(name) && !route.layout.omit.includes(name)) fail(`Unplaced field ${name}`)
    } else if (route.kind === 'page' && route.mode) fail('Entity page needs layout')
    return { path, source, kind: route.kind, title: route.title, nav: route.nav, entity: route.entity, mode: route.mode, uses: [...uses].sort(), layout: route.layout ?? null, editable: route.kind === 'page' }
  })
}

export function routePath(source: string) {
  const name = source.replace(/^\.?\/?ui\//, '').replace(/\.ts$/, '')
  // The spike deliberately supports directory routes and $params only. Reject
  // TanStack dots, pathless/layout prefixes, groups and escapes before import.
  if (!name.split('/').every(part => /^(?:[a-zA-Z][a-zA-Z0-9-]*|\$[a-zA-Z][a-zA-Z0-9]*)$/.test(part)) || name.split('/').slice(0, -1).includes('index') || name.split('/').includes('route')) throw new Error(`Unsupported route filename: ${source}`)
  return '/' + name.split('/').filter(part => part !== 'index').join('/')
}
