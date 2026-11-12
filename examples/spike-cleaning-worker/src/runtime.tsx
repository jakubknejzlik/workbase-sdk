import { useState, type CSSProperties, type FormEvent } from 'react'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { slotInput, type Node, type Page, type Span } from '@workbasehq/ui-v3'
import slots from '../ui/-slots'
import nav from '../ui/nav'
import { t } from './i18n'
import { workers, shifts, saveWorker } from './mock'

export function Shell() {
  return <div className="app"><aside className="sidebar"><div className="brand"><span className="brand-icon">C</span>{t('workers.shell.brand')}</div><p className="eyebrow">{t('workers.shell.console')}</p><nav aria-label={t('workers.nav.group')}>{nav.map(item => <Link key={item.path} to={item.path} activeProps={{ className: 'active' }}>{t(item.title)}</Link>)}</nav><div className="sidebar-foot">{t('workers.shell.spike')}</div></aside><main><div className="topbar"><span>{t('workers.shell.workspace')}</span><span className="badge muted">{t('workers.shell.mock')}</span></div><Outlet /></main></div>
}
type Context = { record: Record<string, unknown>; form: boolean; mode?: Page['mode']; name: string; setName(value: string): void }
function spanStyle(span: Span): CSSProperties {
  const value = typeof span === 'number' ? { xs: span } : span
  let previous = 12
  return Object.fromEntries(['xs', 'sm', 'md', 'lg', 'xl'].map(key => {
    previous = value[key as keyof typeof value] ?? previous
    return [`--span-${key}`, previous]
  })) as CSSProperties
}
function TabView({ nodes, context }: { nodes: Node[]; context: Context }) {
  const [active, setActive] = useState(0)
  return <section className="card tabs"><div role="tablist">{nodes.map((node, index) => typeof node !== 'string' && <button key={node.id} role="tab" aria-selected={active === index} aria-controls={`panel-${node.id}`} id={`tab-${node.id}`} onClick={() => setActive(index)} type="button">{t(node.title!)}</button>)}</div>{nodes.map((node, index) => typeof node !== 'string' && <div role="tabpanel" aria-labelledby={`tab-${node.id}`} id={`panel-${node.id}`} key={node.id} hidden={active !== index}>{node.children?.length ? <Nodes nodes={node.children} context={context} /> : <p>{t('workers.detail.notesEmpty')}</p>}</div>)}</section>
}
function Nodes({ nodes, context }: { nodes: Node[]; context: Context }) {
  return <>{nodes.map((node, index) => {
    if (typeof node === 'string') return <div className="field" key={index}><label htmlFor={context.form ? node : undefined}>{t(`domain:field.worker.${node}`)}</label>{context.form ? <input id={node} name={node} value={context.name} onChange={event => context.setName(event.target.value)} required /> : <strong>{String(context.record[node] ?? '—')}</strong>}</div>
    if (node.kind === 'slot') {
      if (node.props?.when && node.props.when !== context.mode) return null
      const definition = slots[node.id as keyof typeof slots]
      const input = slotInput(definition, node.props ?? {}, context.record)
      return <div key={index}>{definition.render(input as never)}</div>
    }
    if (node.kind === 'related') return <div className="relation" key={index}><table><thead><tr>{node.columns?.map(field => <th key={field}>{t(`domain:field.slot.${field}`)}</th>)}</tr></thead><tbody>{shifts.map((shift, row) => <tr key={row}>{node.columns?.map(field => <td key={field}>{field === 'starts_at' ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(shift.starts_at)) : String(shift[field as keyof typeof shift])}</td>)}</tr>)}</tbody></table></div>
    if (node.kind === 'tabs') return <TabView key={index} nodes={node.children ?? []} context={context} />
    if (node.kind === 'columns' || node.kind === 'row') return <div key={index} className="grid" data-kind={node.kind}>{node.cells?.map((cell, i) => <div className="cell" key={i} style={spanStyle(cell.span)}><Nodes nodes={cell.children} context={context} /></div>)}</div>
    return <section key={index} className={node.kind === 'section' ? 'card' : node.kind}>{node.title && <h2>{t(node.title)}</h2>}<Nodes nodes={node.children ?? []} context={context} /></section>
  })}</>
}
export function RouteView({ definition, params }: { definition: Page; params: Record<string, string | undefined> }) {
  const record = workers.find(item => item.id === params.id)
  // New/edit share one source layout; remount state when TanStack changes the page.
  return <PageBody key={`${definition.mode ?? definition.kind}-${params.id ?? ''}`} definition={definition} record={record} />
}
function PageBody({ definition, record }: { definition: Page; record?: typeof workers[number] }) {
  const [name, setName] = useState(record?.name ?? '')
  const navigate = useNavigate()
  const form = definition.mode === 'create' || definition.mode === 'edit'
  const context: Context = { record: record ?? {}, form, mode: definition.mode, name, setName }
  if (definition.mode !== 'list' && definition.mode !== 'create' && !record) return <h1>{t('workers.shell.notFound')}</h1>
  function submit(event: FormEvent) { event.preventDefault(); const id = saveWorker(record?.id, name); void navigate({ to: '/workers/$id', params: { id } }) }
  const Component = definition.component
  return <article className="page" data-page={definition.mode ?? 'trasa'}><div className="breadcrumb"><Link to="/workers">{t('workers.list.title')}</Link><span>/</span><span>{t(definition.title)}</span></div><header className="page-heading"><div><p className="eyebrow">{t('workers.shell.directory')}</p><h1>{definition.mode === 'detail' ? record?.name : t(definition.title)}</h1><p>{t(form ? 'workers.form.subtitle' : 'workers.detail.subtitle')}</p></div>{record && <div className="actions"><Link to="/workers/$id" params={{ id: record.id }}>{t('workers.detail.title')}</Link><Link to="/workers/$id/edit" params={{ id: record.id }}>{t('workers.edit.title')}</Link><Link className="button" to="/workers/$id/trasa" params={{ id: record.id }}>{t('workers.trasa.title')}</Link></div>}</header>
    {definition.mode === 'list' ? <section className="card"><table><thead><tr>{definition.layout?.nodes.map((node, index) => <th key={index}>{t(typeof node === 'string' ? `domain:field.worker.${node}` : 'workers.access.title')}</th>)}</tr></thead><tbody>{workers.map(worker => <tr key={worker.id}>{definition.layout?.nodes.map((node, index) => <td key={index}>{typeof node === 'string' ? <Link to="/workers/$id" params={{ id: worker.id }}>{String(worker[node as keyof typeof worker])}</Link> : <Nodes nodes={[node]} context={{ ...context, record: worker }} />}</td>)}</tr>)}</tbody></table></section>
      : Component ? <Component record={Object.fromEntries(definition.uses.filter(use => use.startsWith('worker.')).map(use => [use.split('.')[1], context.record[use.split('.')[1]]]))} />
        : form ? <form onSubmit={submit}><Nodes nodes={definition.layout?.nodes ?? []} context={context} /><footer className="form-actions"><button className="primary" type="submit">{t('workers.form.save')}</button><Link to="/workers">{t('workers.form.cancel')}</Link></footer></form>
          : <Nodes nodes={definition.layout?.nodes ?? []} context={context} />}
  </article>
}
