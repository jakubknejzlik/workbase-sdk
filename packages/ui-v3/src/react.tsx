import { createContext, useContext, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { resolvedSpans, routePath, slotInput, type Field, type Layout, type Node, type Page as TypedPage, type Schema, type Slots, type Span } from './index'
import { type DataStore, type RecordData } from './store'
export { createMemoryStore } from './store'

// Rendering consumes the common data shape; authoring keeps concrete schema types.
type Page = Omit<TypedPage, 'layout'> & { layout?: Layout }
type PageSource = { source: string; definition: Page }
type Runtime = {
  schema: Schema; slots: Slots; store: DataStore
  nav: { path: string; title: string; group?: string }[]
  pages: PageSource[]
  t(key: string): string
  language?: string
}
const UI = createContext<Runtime | null>(null)
export function UIProvider({ children, ...runtime }: Runtime & { children: ReactNode }) { return <UI.Provider value={runtime}>{children}</UI.Provider> }
function useUI() { const runtime = useContext(UI); if (!runtime) throw new Error('UIProvider required'); return runtime }
export function Shell() {
  const { t, nav } = useUI()
  return <div className="app"><aside className="sidebar"><div className="brand"><span className="brand-icon">D</span>{t('sdk:brand')}</div><p className="eyebrow">{t('sdk:console')}</p><nav aria-label={t('sdk:navigation')}>{nav.map(item => <Link key={item.path} to={item.path} activeProps={{ className: 'active' }}>{t(item.title)}</Link>)}</nav><div className="sidebar-foot">{t('sdk:spike')}</div></aside><main><div className="topbar"><span>{t('sdk:workspace')}</span><span className="badge muted">{t('sdk:mock')}</span></div><Outlet /></main></div>
}
type Context = { entity?: string; record: Record<string, unknown>; form: boolean; mode?: Page['mode']; setValue(name: string, value: unknown): void }
function spanStyle(span: Span): CSSProperties { return Object.fromEntries(resolvedSpans(span).map((value, index) => [`--span-${['xs', 'sm', 'md', 'lg', 'xl'][index]}`, value])) as CSSProperties }
function fieldLabel(schema: Schema, entity: string, name: string) { return `domain:field.${schema[entity].singular}.${name}` }
function useDisplay() {
  const { schema, store, language = 'en', t } = useUI()
  return (entity: string, name: string, value: unknown): string => {
    if (value === undefined || value === null || value === '') return '—'
    const field = schema[entity].fields[name]
    if (field.type === 'ref' && field.entity) {
      const target = store.get(field.entity, String(value))
      return String(target?.[schema[field.entity].displayField ?? 'id'] ?? value)
    }
    if (field.type === 'enum') return t(`domain:enum.${schema[entity].singular}.${name}.${value}`)
    if (field.type === 'datetime') return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(String(value)))
    if (typeof value === 'number') return new Intl.NumberFormat(language).format(value)
    return String(value)
  }
}
function FieldInput({ name, field, context }: { name: string; field: Field; context: Context }) {
  const { schema, store, t } = useUI()
  const value = context.record[name] ?? field.default ?? ''
  const common = { id: name, name, required: field.required, disabled: field.readOnly }
  if (field.type === 'enum' || field.type === 'ref' && field.entity) {
    const options = field.type === 'enum' ? (field.values ?? []).map(value => ({ value, label: t(`domain:enum.${schema[context.entity!].singular}.${name}.${value}`) })) : store.list(field.entity!).map(row => ({ value: row.id, label: String(row[schema[field.entity!].displayField ?? 'id']) }))
    return <select {...common} value={String(value)} onChange={event => context.setValue(name, event.target.value)}><option value="">—</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  }
  const type = field.type === 'boolean' ? 'checkbox' : ['int', 'number'].includes(field.type) ? 'number' : field.type === 'datetime' ? 'datetime-local' : 'text'
  return <input {...common} type={type} step={field.type === 'int' ? 1 : undefined} checked={type === 'checkbox' ? !!value : undefined} value={type === 'checkbox' ? undefined : type === 'datetime-local' && value ? String(value).slice(0, 16) : String(value)} onChange={event => context.setValue(name, type === 'checkbox' ? event.target.checked : type === 'number' ? event.target.value === '' ? '' : Number(event.target.value) : type === 'datetime-local' && event.target.value ? new Date(event.target.value).toISOString() : event.target.value)} />
}
function TabView({ nodes, context }: { nodes: Node[]; context: Context }) {
  const { t } = useUI()
  const [active, setActive] = useState(0)
  return <section className="card tabs"><div role="tablist">{nodes.map((node, index) => typeof node !== 'string' && <button key={node.id} role="tab" aria-selected={active === index} aria-controls={`panel-${node.id}`} id={`tab-${node.id}`} onClick={() => setActive(index)} type="button">{t(node.title!)}</button>)}</div>{nodes.map((node, index) => typeof node !== 'string' && <div role="tabpanel" aria-labelledby={`tab-${node.id}`} id={`panel-${node.id}`} key={node.id} hidden={active !== index}><Nodes nodes={node.children ?? []} context={context} /></div>)}</section>
}
function Nodes({ nodes, context }: { nodes: Node[]; context: Context }) {
  const { schema, slots, store, t } = useUI()
  const display = useDisplay()
  return <>{nodes.map((node, index) => {
    if (typeof node === 'string') return <div className="field" key={index}><label htmlFor={context.form ? node : undefined}>{t(fieldLabel(schema, context.entity!, node))}</label>{context.form ? <FieldInput name={node} field={schema[context.entity!].fields[node]} context={context} /> : <strong>{display(context.entity!, node, context.record[node])}</strong>}</div>
    if (node.kind === 'slot') {
      if (node.props?.when && node.props.when !== context.mode) return null
      const definition = slots[node.id!]
      return <div key={index}>{definition.render(slotInput(definition, node.props ?? {}, context.record))}</div>
    }
    if (node.kind === 'related') {
      const target = schema[context.entity!].relations[node.id!].entity
      const rows = context.record.id ? store.related(context.entity!, String(context.record.id), node.id!) : []
      return <div className="relation" data-relation={node.id} key={index}><table><thead><tr>{node.columns?.map(field => <th key={field}>{t(fieldLabel(schema, target, field))}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{node.columns?.map(field => <td key={field}>{display(target, field, row[field])}</td>)}</tr>)}</tbody></table>{!rows.length && <p>{t('sdk:empty')}</p>}</div>
    }
    if (node.kind === 'tabs') return <TabView key={index} nodes={node.children ?? []} context={context} />
    if (node.kind === 'columns' || node.kind === 'row') return <div key={index} className="grid" data-kind={node.kind}>{node.cells?.map((cell, i) => <div className="cell" key={i} style={spanStyle(cell.span)}><Nodes nodes={cell.children} context={context} /></div>)}</div>
    if (node.kind === 'action') throw new Error(`No command registry: ${node.id}`)
    return <section key={index} className={node.kind === 'section' ? 'card' : node.kind}>{node.title && <h2>{t(node.title)}</h2>}<Nodes nodes={node.children ?? []} context={context} /></section>
  })}</>
}
export function RouteView({ definition, params }: { definition: Page; params: Record<string, string | undefined> }) {
  const { store, pages } = useUI()
  const source = pages.find(page => page.definition === definition)?.source ?? ''
  // File-derived context supports custom pages without embedding entity names.
  const entity = definition.entity ?? source.split('/')[1]
  const record = params.id && entity ? store.get(entity, params.id) : undefined
  return <PageBody key={`${source}-${params.id ?? ''}`} definition={definition} entity={entity} record={record} />
}
function PageBody({ definition, entity, record }: { definition: Page; entity?: string; record?: RecordData }) {
  const { schema, store, pages, t } = useUI()
  const display = useDisplay()
  const navigate = useNavigate()
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...record }))
  const [error, setError] = useState('')
  const form = definition.mode === 'create' || definition.mode === 'edit'
  const context: Context = { entity, record: form ? values : record ?? {}, form, mode: definition.mode, setValue(name, value) { setValues(current => ({ ...current, [name]: value })) } }
  const entityPages = pages.filter(page => (page.definition.entity ?? page.source.split('/')[1]) === entity)
  const route = (mode: Page['mode']) => entityPages.find(page => page.definition.mode === mode)
  const href = (source: string, id?: string) => routePath(source).replace('$id', encodeURIComponent(id ?? ''))
  const list = route('list')
  const detail = route('detail')
  if ((definition.mode === 'detail' || definition.mode === 'edit' || definition.kind === 'customPage' && entity && schema[entity]) && !record) return <h1>{t('sdk:notFound')}</h1>
  function submit(event: FormEvent) {
    event.preventDefault()
    try {
      const saved = store.save(entity!, record?.id, values)
      void navigate({ to: detail ? href(detail.source, saved.id) : list ? href(list.source) : '/' })
    } catch (error) { setError(String(error)) }
  }
  const Component = definition.component
  let rows = entity && definition.mode === 'list' ? [...store.list(entity)] : []
  const order = definition.layout?.orderBy
  if (order) rows = rows.sort((a, b) => String(a[order] ?? '').localeCompare(String(b[order] ?? '')))
  return <article className="page" data-page={definition.mode ?? definition.kind} data-entity={entity}><div className="breadcrumb">{list && <Link to={href(list.source)}>{t(list.definition.title)}</Link>}<span>/</span><span>{t(definition.title)}</span></div><header className="page-heading"><h1>{definition.mode === 'detail' && entity && record ? String(record[schema[entity].displayField ?? 'id']) : t(definition.title)}</h1>{record && <div className="actions">{entityPages.filter(page => ['detail', 'edit'].includes(page.definition.mode ?? '') || page.definition.kind === 'customPage').map(page => <Link key={page.source} to={href(page.source, record.id)}>{t(page.definition.title)}</Link>)}</div>}</header>
    {definition.mode === 'list' ? <section className="card"><table><thead><tr>{definition.layout?.nodes.map((node, index) => <th key={index}>{typeof node === 'string' ? t(fieldLabel(schema, entity!, node)) : node.title ? t(node.title) : ''}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{definition.layout?.nodes.map((node, index) => <td key={index}>{typeof node === 'string' ? detail ? <Link to={href(detail.source, row.id)}>{display(entity!, node, row[node])}</Link> : display(entity!, node, row[node]) : <Nodes nodes={[node]} context={{ ...context, record: row }} />}</td>)}</tr>)}</tbody></table></section>
      : Component ? <Component record={Object.fromEntries(definition.uses.filter(use => entity && use.startsWith(schema[entity]?.singular + '.')).map(use => [use.split('.')[1], context.record[use.split('.')[1]]]))} />
        : form ? <form onSubmit={submit}><Nodes nodes={definition.layout?.nodes ?? []} context={context} />{error && <p role="alert">{error}</p>}<footer className="form-actions"><button className="primary" type="submit">{t('sdk:save')}</button>{list && <Link to={href(list.source)}>{t('sdk:cancel')}</Link>}</footer></form>
          : <Nodes nodes={definition.layout?.nodes ?? []} context={context} />}
  </article>
}
