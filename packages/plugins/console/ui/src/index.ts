/** Browser-safe data contract. No consumer code is evaluated by these helpers. */
export type ParamSpec = { kind: 'id'; entity: string } | { kind: 'string'; default?: string } | { kind: 'int'; min?: number; default?: number }
export const param = Object.assign((name: string) => ({ kind: 'param' as const, name }), {
  id: (entity: string): ParamSpec => ({ kind: 'id', entity }),
  string: (options: { default?: string } = {}): ParamSpec => ({ kind: 'string', ...options }),
  int: (options: { min?: number; default?: number } = {}): ParamSpec => ({ kind: 'int', ...options }),
})
export type Binding = { kind: 'one' | 'list'; entity: string; bind: Record<string, ReturnType<typeof param>> }
export const one = (entity: string, bind: Binding['bind']): Binding => ({ kind: 'one', entity, bind })
export const list = (entity: string, bind: Binding['bind'] = {}): Binding => ({ kind: 'list', entity, bind })
export function query(): never { throw new Error('query is not in slice 7') }
export function parseParams(specs: Record<string, ParamSpec>, input: Record<string, unknown>): Record<string, string | number> {
  if (Object.keys(input).some(key => !Object.hasOwn(specs, key))) throw new Error('Unexpected params')
  return Object.fromEntries(Object.entries(specs).map(([key, spec]) => {
    // Own keys only: names like constructor must not resolve to Object.prototype members.
    const raw = (Object.hasOwn(input, key) ? input[key] : undefined) ?? (Object.hasOwn(spec, 'default') ? (spec as { default?: unknown }).default : undefined)
    if (spec.kind !== 'int') {
      if (typeof raw !== 'string' || spec.kind === 'id' && !raw.length) throw new Error(`Invalid param ${key}`)
      return [key, raw]
    }
    const value = typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || spec.min !== undefined && value < spec.min) throw new Error(`Invalid param ${key}`)
    return [key, value]
  }))
}
export function buildPath(to: string, params: Record<string, string | number>): string {
  const names = to.split('/').filter(part => part.startsWith('$')).map(part => part.slice(1))
  if (names.some(name => !Object.hasOwn(params, name)) || Object.keys(params).some(name => !names.includes(name))) throw new Error('Missing or extra path params')
  return to.split('/').map(part => {
    if (!part.startsWith('$')) return part
    const value = params[part.slice(1)]
    if (!['string', 'number'].includes(typeof value) || value === '' || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid path params')
    return encodeURIComponent(value)
  }).join('/')
}
export type EntityShape = { fields: Record<string, { type: string; userLink?: boolean }> }
export type Field<E extends EntityShape> = keyof E['fields'] & string
export type PropSpec = { kind: 'field'; type: string } | { kind: 'boolean'; default?: boolean } | { kind: 'when' }
export const p = {
  field: (type: string): PropSpec => ({ kind: 'field', type }),
  boolean: (options: { default?: boolean } = {}): PropSpec => ({ kind: 'boolean', ...options }),
  when: (): PropSpec => ({ kind: 'when' }),
}
export type Slot = { contexts: ('record' | 'form' | 'row')[]; props: Record<string, PropSpec>; component: (...args: any[]) => any }
export const defineSlots = <const S extends Record<string, Slot>>(slots: S): S => slots
export type Node<F extends string = string> = F | { kind: 'section' | 'row' | 'columns' | 'tabs' | 'tab'; title?: string; children: Node<F>[] } | { kind: 'slot'; id: string; props: Record<string, string | boolean> }
export const slot = (id: string, props: Record<string, string | boolean> = {}): Node<never> => ({ kind: 'slot', id, props })
export const layout = <E extends EntityShape>(nodes: Node<Field<E>>[]): Node<Field<E>>[] => nodes
export type Target = { entity: string; mode: 'list' | 'detail' | 'edit' }
export const link = (entity: string, mode: Target['mode'] = 'detail'): Target => ({ entity, mode })
export const defineNav = <const T extends { title: string; target: Target }[]>(items: T): T => items
export type Page = {
  kind: 'page' | 'customPage'; title: string; params: Record<string, ParamSpec>; search: Record<string, ParamSpec>
  data: Record<string, Binding>; layout: Node[]; entity?: string; mode?: 'list' | 'detail' | 'create' | 'edit'; uses: string[]
  component?: (...args: any[]) => any
}
type PageInput = Pick<Page, 'title'> & Partial<Omit<Page, 'kind' | 'title' | 'component'>>
export const page = (input: PageInput): Page => ({ params: {}, search: {}, data: {}, layout: [], uses: [], ...input, kind: 'page' })
export const customPage = (input: PageInput & Required<Pick<Page, 'component' | 'uses'>>): Page => ({ ...page(input), kind: 'customPage' })
type EntityOptions<E extends EntityShape> = Omit<PageInput, 'entity' | 'mode' | 'layout'> & { layout?: Node<Field<E>>[] }
export const entityListPage = <E extends EntityShape = EntityShape>(entity: string, options: EntityOptions<E>): Page => page({ ...options, entity, mode: 'list', data: { records: list(entity), ...options.data } })
export const entityCreatePage = <E extends EntityShape = EntityShape>(entity: string, options: EntityOptions<E>): Page => page({ ...options, entity, mode: 'create' })
function recordPage<E extends EntityShape>(mode: 'detail' | 'edit', entity: string, options: EntityOptions<E> & { recordParam: string }): Page {
  const { recordParam, ...input } = options
  return page({ ...input, entity, mode, params: { [recordParam]: param.id(entity), ...input.params }, data: { record: one(entity, { id: param(recordParam) }), ...input.data } })
}
export const entityDetailPage = <E extends EntityShape = EntityShape>(entity: string, options: EntityOptions<E> & { recordParam: string }): Page => recordPage('detail', entity, options)
export const entityEditPage = <E extends EntityShape = EntityShape>(entity: string, options: EntityOptions<E> & { recordParam: string }): Page => recordPage('edit', entity, options)
