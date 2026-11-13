import { createContext, createElement as h, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker, useNavigate } from '@tanstack/react-router'
import { ApiFailure, cacheKey, canonicalJSON, createClient, diff, type Client, type ClientRequestInit, type EntityMeta, type FieldMeta, type Issue, type RecordData } from '../client'
import { buildPath, type Node, type Page, type Slot } from '../index'
import type { Manifest, ResolvedLink } from '../check'
import type { I18n, Translate } from '../i18n'
import { TranslationContext } from '../i18n-context'
export type State<T> = { kind: 'loading' | 'empty' | 'notFound' | 'forbidden' | 'network' } | { kind: 'ready'; data: T } | { kind: 'validation'; issues: Issue[] }
export function failureState(error: unknown): State<never> {
  return error instanceof ApiFailure && error.status === 404 ? { kind: 'notFound' } : error instanceof ApiFailure && error.status === 403 ? { kind: 'forbidden' }
    : error instanceof ApiFailure && error.issues ? { kind: 'validation', issues: error.issues } : { kind: 'network' }
}
type Runtime = { client: Client; identity: { actorId: string; orgId: string }; t: Translate; slots: Record<string, Slot> }
const browser = globalThis as typeof globalThis & { confirm(message: string): boolean }
const Context = createContext<Runtime | null>(null)
export type ProviderProps = { identity: Runtime['identity']; t: Runtime['t']; baseURL?: string; fetch?: (url: string, init: ClientRequestInit) => Promise<Response>; slots?: Record<string, Slot>; i18n?: I18n; children?: ReactNode }
/** Scope replacement remounts observers and drafts, and discards both caches. */
export function ConsoleProvider({ identity, t, baseURL = '', fetch: transport = globalThis.fetch, slots = {}, i18n, children }: ProviderProps) {
  const language = useSyncExternalStore(i18n?.subscribe ?? (() => () => {}), i18n?.language ?? (() => ''), i18n?.language ?? (() => ''))
  // A fresh translator identity per language makes memoized authored consumers re-render on language change.
  const translate = useMemo<Translate>(() => t.bind(null), [t, language])
  const client = useMemo(() => createClient({ baseURL, ...identity, fetch: transport }), [baseURL, identity.actorId, identity.orgId, transport])
  const queries = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } } }), [client])
  useEffect(() => client.subscribe(() => { void queries.invalidateQueries() }), [client, queries])
  useEffect(() => () => queries.clear(), [queries])
  return h(Context.Provider, { value: { client, identity, t, slots }, key: canonicalJSON([baseURL, identity]) }, h(TranslationContext.Provider, { value: translate }, h(QueryClientProvider, { client: queries }, children)))
}
function useRuntime() { const runtime = useContext(Context); if (!runtime) throw new Error('ConsoleProvider is required'); return runtime }
export function useRecord(entity: string, id: string) {
  const { client } = useRuntime()
  const query = useQuery({ queryKey: [cacheKey('one', entity, { id })], queryFn: ({ signal }) => client.one(entity, { id }, signal) })
  const state: State<RecordData> = query.data ? { kind: 'ready', data: query.data } : query.isPending ? { kind: 'loading' } : failureState(query.error)
  return { state, reload: async () => { client.invalidate(); const result = await query.refetch(); if (result.error) throw result.error; return result.data! } }
}
export function useList(entity: string, metadata: EntityMeta, bind: Record<string, string>) {
  const { client } = useRuntime(), queries = useQueryClient(), key = canonicalJSON(bind), metaKey = canonicalJSON(metadata)
  const session = useMemo(() => client.list(entity, metadata), [client, entity, metaKey, key])
  const queryKey = cacheKey('list', entity, { bind, metadata })
  const query = useInfiniteQuery({ queryKey: [queryKey], initialPageParam: false,
    queryFn: ({ signal, pageParam }) => pageParam ? session.more(signal) : session.load(bind, signal),
    getNextPageParam: page => page.next_cursor ? true : undefined,
  })
  // Cursor chains belong to one mounted binding; revisiting a search starts at page one.
  useEffect(() => () => queries.removeQueries({ queryKey: [queryKey], exact: true }), [queries, queryKey])
  const rows = query.data?.pages.flatMap(page => page.data) ?? []
  const state: State<RecordData[]> = query.error ? failureState(query.error) : query.isPending ? { kind: 'loading' } : rows.length ? { kind: 'ready', data: rows } : { kind: 'empty' }
  return { state, more: () => { void query.fetchNextPage() }, hasMore: query.hasNextPage, loadingMore: query.isFetchingNextPage }
}
type FieldProps = { field: FieldMeta; name: string; t: Translate; enumKey: string; value: unknown; change: (value: unknown) => void; error?: string }
const input = (type: string, numeric = false) => ({ name, value, change, error }: FieldProps) => h('input', { 'aria-label': name, 'aria-invalid': !!error, type, value: value == null ? '' : String(value), onChange: (e: { target: { value: string } }) => change(numeric && e.target.value !== '' ? Number(e.target.value) : e.target.value) })
const structuralStyle = { row: { display: 'flex', flexWrap: 'wrap' as const, gap: '1rem' }, columns: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))', gap: '1rem' } }
const fieldRenderers: Record<string, (props: FieldProps) => ReactNode> = {
  string: input('text'), text: input('text'), int: input('number', true), float: input('number', true), datetime: input('text'),
  bool: ({ name, value, change, error, t: translate }) => h('select', { 'aria-label': name, 'aria-invalid': !!error, value: value == null ? '' : String(value), onChange: (e: { target: { value: string } }) => change(e.target.value === '' ? null : e.target.value === 'true') }, ...['', 'true', 'false'].map(v => h('option', { key: v, value: v }, v ? translate('sdk:' + v) : ''))),
  enum: ({ field, name, value, change, error, t: translate, enumKey }) => h('select', { 'aria-label': name, 'aria-invalid': !!error, value: value == null ? '' : String(value), onChange: (e: { target: { value: string } }) => change(e.target.value) }, h('option', { value: '' }, ''), ...field.values!.map(v => h('option', { key: v, value: v }, translate(enumKey + v)))),
  ref: () => null,
}
export type RenderContext = Runtime & { metadata: EntityMeta; entity: string; mode?: Page['mode']; record: Record<string, unknown>; draft?: Record<string, unknown>; change?: (name: string, value: unknown) => void; issues?: Issue[] }
/** Every structural node shares this traversal; fields dispatch solely by metadata type. */
export function renderNode(node: Node, ctx: RenderContext): ReactNode {
  if (typeof node !== 'string') {
    if (node.kind === 'action') return null // Live action rendering belongs to the capabilities slice.
    if (node.kind === 'tabs') return h(Tabs, { node, ctx })
    if (node.kind !== 'slot') return h(node.kind === 'section' || node.kind === 'tab' ? 'section' : 'div', { 'data-layout': node.kind, style: structuralStyle[node.kind as keyof typeof structuralStyle] }, 'title' in node && node.title && h('h2', null, ctx.t('ui:' + node.title)), ...node.children.map((child, i) => h('div', { key: i }, renderNode(child, ctx))))
    const slot = ctx.slots[node.id]
    if (!slot) return h('p', { role: 'alert' }, ctx.t('sdk:unsupported') + ': ' + node.id)
    const props: Record<string, unknown> = {}
    for (const [key, spec] of Object.entries(slot.props)) {
      const value = node.props[key] ?? ('default' in spec ? spec.default : undefined)
      if (spec.kind === 'when' && value !== ctx.mode) return null
      props[key] = spec.kind === 'field' ? (ctx.draft ?? ctx.record)[String(value)] : spec.kind === 'key' ? ctx.t('ui:' + value) : value
    }
    return h(slot.component, { ...props, t: ctx.t, identity: ctx.identity })
  }
  const field = ctx.metadata.fields[node], renderer = field && fieldRenderers[field.type]
  const editable = !!ctx.change && field && !field.readOnly && !field.computed && !field.userLink
  if (!renderer || editable && field.type === 'ref') return h('p', { role: 'alert' }, ctx.t('sdk:unsupported') + ': ' + (field?.type ?? node))
  const error = ctx.issues?.filter(issue => issue.path[0] === node).map(issue => issue.code).join(', ')
  return h('div', null, h('label', null, ctx.t('domain:field.' + ctx.entity + '.' + node)), editable ? renderer({ field, name: ctx.t('domain:field.' + ctx.entity + '.' + node), t: ctx.t, enumKey: 'domain:enum.' + ctx.entity + '.' + node + '.', value: ctx.draft?.[node], change: value => ctx.change!(node, value), error }) : h('span', null, field.type === 'enum' && ctx.record[node] != null ? ctx.t('domain:enum.' + ctx.entity + '.' + node + '.' + ctx.record[node]) : String(ctx.record[node] ?? '')), error && h('span', { role: 'alert' }, ctx.t(error === 'required' ? 'sdk:required' : 'sdk:validation')))
}
function Tabs({ node, ctx }: { node: Exclude<Node, string | { kind: 'slot' } | { kind: 'action' }>; ctx: RenderContext }) {
  const [active, setActive] = useState(0)
  return h('div', null, 'title' in node && node.title && h('h2', null, ctx.t('ui:' + node.title)),
    h('div', { role: 'tablist' }, ...node.children.map((child, i) => h('button', { key: i, type: 'button', role: 'tab', 'aria-selected': active === i, onClick: () => setActive(i) }, typeof child !== 'string' && 'title' in child && child.title ? ctx.t('ui:' + child.title) : String(i + 1)))),
    h('div', { role: 'tabpanel' }, node.children[active] && renderNode(node.children[active], ctx)))
}
function message(state: State<unknown>, translate: Runtime['t']) { return state.kind === 'ready' ? null : h('p', { role: state.kind === 'loading' ? 'status' : 'alert' }, translate('sdk:' + state.kind)) }
function path(link: ResolvedLink | undefined, id?: string) {
  if (!link) return undefined
  return buildPath(link.to, Object.fromEntries(Object.keys(link.bind).map(name => [name, id ?? ''])))
}
type ViewProps = { definition: Page; route: Manifest['routes'][number]; entities: Manifest['entities']; params: Record<string, string | number>; search: Record<string, string | number>; navigate: (path: string) => void; slots?: Record<string, Slot>; routes?: Manifest['routes']; onDirty?: (dirty: boolean) => void }
function Form({ props, metadata, initial, reload }: { props: ViewProps; metadata: EntityMeta; initial: Record<string, unknown>; reload?: () => Promise<RecordData> }) {
  const runtime = useRuntime(), { client, t: translate } = runtime, { definition, route, navigate, onDirty } = props
  const [hadConflict, setHadConflict] = useState(false)
  const [base, setBase] = useState(initial), [draft, setDraft] = useState(initial), [failure, setFailure] = useState<unknown>(), [saving, setSaving] = useState(false)
  const [draftKey] = useState(() => crypto.randomUUID()), controller = useRef<AbortController | null>(null)
  const dirty = canonicalJSON(base) !== canonicalJSON(draft)
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty, onDirty])
  useEffect(() => () => controller.current?.abort(), [])
  const destination = (id?: string) => path(route.links.detail, id) ?? path(route.links.list)
  function leave(to: string | undefined, confirm = true) {
    if (!to || confirm && dirty && !browser.confirm(translate('sdk:discardChanges'))) return
    onDirty?.(false); navigate(to)
  }
  async function save() {
    if (saving) return
    setFailure(undefined)
    try {
      const body = diff(metadata, definition.layout, base, draft)
      if (!Object.keys(body).length) { if (definition.mode === 'edit') leave(destination(String(base.id)), false); return }
      controller.current?.abort(); controller.current = new AbortController(); const signal = controller.current.signal
      setSaving(true)
      const row = definition.mode === 'create' ? await client.create(definition.entity!, body, draftKey, signal) : await client.update(definition.entity!, String(base.id), Number(base.version), body, signal)
      signal.throwIfAborted(); setBase(row); setDraft(row); leave(destination(row.id), false)
    } catch (error) { if (!controller.current?.signal.aborted) { setFailure(error); if (error instanceof ApiFailure && error.status === 409 && error.code === 'version_conflict') setHadConflict(true) } }
    finally { if (!controller.current?.signal.aborted) setSaving(false) }
  }
  async function reloadCopy() {
    controller.current?.abort(); controller.current = new AbortController(); const signal = controller.current.signal
    setSaving(true)
    try { const row = await reload!(); signal.throwIfAborted(); setBase(row); setDraft(row); setFailure(undefined); setHadConflict(false) }
    catch (error) { if (!signal.aborted) setFailure(error) }
    finally { if (!signal.aborted) setSaving(false) }
  }
  const conflict = hadConflict
  const state = failure ? failureState(failure) : undefined
  const ctx: RenderContext = { ...runtime, slots: props.slots ?? runtime.slots, metadata, entity: definition.entity!, mode: definition.mode, record: base, draft, change: (name, value) => setDraft(current => ({ ...current, [name]: value })), issues: state?.kind === 'validation' ? state.issues : [] }
  return h('form', { noValidate: true, onSubmit: (e: { preventDefault(): void }) => { e.preventDefault(); void save() } },
    conflict ? h('div', { role: 'alert' }, translate('sdk:conflict'), h('button', { type: 'button', disabled: saving, onClick: () => { void reloadCopy() } }, translate('sdk:reloadServerCopy'))) : state && message(state, translate),
    ...definition.layout.map((node, i) => h('div', { key: i }, renderNode(node, ctx))),
    h('button', { type: 'submit', disabled: saving }, translate('sdk:save')),
    h('button', { type: 'button', disabled: saving, onClick: () => leave(definition.mode === 'create' ? path(route.links.list) : destination(String(base.id))) }, translate('sdk:back')),
    h('button', { type: 'button', disabled: saving, onClick: () => leave(definition.mode === 'create' ? path(route.links.list) : destination(String(base.id))) }, translate('sdk:cancel')))
}
function RecordView({ props, metadata, id }: { props: ViewProps; metadata: EntityMeta; id: string }) {
  const runtime = useRuntime(), { state, reload } = useRecord(props.definition.entity!, id)
  if (state.kind !== 'ready') return message(state, runtime.t)
  if (props.definition.mode === 'edit') return h(Form, { props, metadata, initial: state.data, reload })
  const ctx = { ...runtime, slots: props.slots ?? runtime.slots, metadata, entity: props.definition.entity!, record: state.data, mode: props.definition.mode }
  return h('div', null, ...props.definition.layout.map((node, i) => h('div', { key: i }, renderNode(node, ctx))),
    props.route.links.edit && h('button', { onClick: () => props.navigate(path(props.route.links.edit, state.data.id)!) }, runtime.t('sdk:edit')))
}
function ListView({ props, metadata }: { props: ViewProps; metadata: EntityMeta }) {
  const runtime = useRuntime(), { t: translate } = runtime, binding = Object.values(props.definition.data).find(binding => binding.kind === 'list')
  const resolved = Object.fromEntries(Object.entries(binding?.bind ?? {}).map(([key, ref]) => [key, String(props.search[ref.name] ?? props.params[ref.name] ?? '')]))
  const [bind, setBind] = useState(resolved), { state, more, hasMore, loadingMore } = useList(props.definition.entity!, metadata, bind)
  const create = props.routes?.filter(route => route.entity === props.definition.entity && route.mode === 'create')
  const createPath = create?.length === 1 && !Object.keys(create[0].params).length ? buildPath(create[0].path, {}) : undefined
  useEffect(() => setBind(resolved), [canonicalJSON(resolved)])
  return h('div', null,
    h('p', null, translate('domain:entity.' + props.definition.entity, { count: state.kind === 'ready' ? state.data.length : 0 })),
    createPath && h('button', { onClick: () => props.navigate(createPath) }, translate('sdk:create')),
    h('input', { 'aria-label': translate('sdk:search'), value: bind.search ?? '', onChange: (e: { target: { value: string } }) => setBind(current => ({ ...current, search: e.target.value })) }),
    h('select', { 'aria-label': translate('sdk:sort'), value: bind.sort || metadata.displayField, onChange: (e: { target: { value: string } }) => setBind(current => ({ ...current, sort: e.target.value })) }, ...Object.keys(metadata.fields).map(field => h('option', { key: field, value: field }, translate('domain:field.' + props.definition.entity + '.' + field)))),
    h('select', { 'aria-label': translate('sdk:direction'), value: bind.dir || 'asc', onChange: (e: { target: { value: string } }) => setBind(current => ({ ...current, dir: e.target.value })) }, ...['asc', 'desc'].map(dir => h('option', { key: dir, value: dir }, translate('sdk:' + dir)))),
    message(state, translate), state.kind === 'ready' && h('ul', null, ...state.data.map(record => h('li', { key: record.id },
      props.route.links.detail && h('button', { onClick: () => props.navigate(path(props.route.links.detail, record.id)!) }, String(record[metadata.displayField] ?? record.id)),
      ...props.definition.layout.map((node, i) => h('div', { key: i }, renderNode(node, { ...runtime, slots: props.slots ?? runtime.slots, metadata, entity: props.definition.entity!, record, mode: 'list' })))))),
    hasMore && h('button', { disabled: loadingMore, onClick: more }, translate('sdk:loadMore')))
}
/** Standalone view also permits a host to inject its own navigation. */
export function PageView(input: ViewProps) {
  const runtime = useRuntime(), { t: translate } = runtime, primary = Object.values(input.definition.data)[0]
  const definition = { ...input.definition, entity: input.definition.entity ?? primary?.entity, mode: input.definition.mode ?? (primary?.kind === 'list' ? 'list' : primary ? 'detail' : undefined) }
  const props = { ...input, definition }, { route } = props
  const metadata = definition.entity && props.entities[definition.entity]
  const binding = Object.values(definition.data).find(binding => binding.kind === 'one')
  const id = binding?.bind.id && String(props.params[binding.bind.id.name] ?? props.search[binding.bind.id.name] ?? '')
  const back = path(route.links.list)
  const content = definition.kind === 'customPage' ? h(definition.component!) : !metadata ? h('div', null, ...definition.layout.map((node, i) => h('div', { key: i }, renderNode(node, { ...runtime, slots: props.slots ?? runtime.slots, metadata: { displayField: '', fields: {} }, entity: '', record: {} })))) : definition.mode === 'list' ? h(ListView, { props, metadata }) : definition.mode === 'create' ? h(Form, { props, metadata, initial: {} }) : id ? h(RecordView, { key: definition.entity + ':' + id, props, metadata, id }) : h('p', { role: 'alert' }, translate('sdk:notFound'))
  return h('main', null, h('h1', null, translate('ui:' + definition.title)), back && !['create', 'edit'].includes(definition.mode ?? '') && h('button', { onClick: () => props.navigate(back) }, translate('sdk:back')), content)
}
/** Generated wrappers run inside TanStack Router; browser back also guards drafts. */
export function RouteView(props: Omit<ViewProps, 'navigate' | 'onDirty'>) {
  const { t: translate } = useRuntime(), navigate = useNavigate(), dirty = useRef(false)
  useBlocker({ shouldBlockFn: () => dirty.current && !browser.confirm(translate('sdk:discardChanges')), enableBeforeUnload: () => dirty.current })
  return h(PageView, { ...props, navigate: to => { void navigate({ to }) }, onDirty: value => { dirty.current = value } })
}

/** Language choice is in memory; profile persistence belongs to the host. */
export function LanguageSwitcher({ i18n }: { i18n: I18n }) {
  const language = useSyncExternalStore(i18n.subscribe, i18n.language, i18n.language)
  return i18n.languages.length > 1 ? h('select', { 'aria-label': i18n.t('sdk:language'), value: language, onChange: (event: { target: { value: string } }) => { void i18n.changeLanguage(event.target.value) } }, ...i18n.languages.map(lang => h('option', { key: lang, value: lang }, lang))) : null
}
