import { EntityCalendar } from './calendar'
import { availableCalendar } from './calendar-model'
import { relationEmptyKey } from './many-to-many'
import { useState, type ReactNode } from 'react'
import { useQuery, useInfiniteQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEntityTranslation } from './entity-translation'
import { Button, DataTable, DataTableSearch, DataTableActiveFilters, DetailFields, DetailPage, ResourcePage, QueryBoundary } from '@workbasehq/ui'
import { recordLabel, formatValue, projection, readQuery, relationQuery, readableRelations, separateRelations, listSearchableFields, visibleEntities, type Capabilities, type Model, type ReadQuery, type Result, type Field } from './read'
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@workbasehq/ui/components/ui/card'
import { Badge } from '@workbasehq/ui/components/ui/badge'
import { Button as PrimitiveButton } from '@workbasehq/ui/components/ui/button'
import { useGeneratedList, useRelationLabels } from './useGeneratedList'
import { filterKind, filterMapping } from './filter-kinds'
import { HeaderFilter } from './header-filter'
import { readableWhere, sortableFields } from './list-model'
import { hasRowActions } from './write'
import { breadcrumbRecordLabel, usePublishRecordBreadcrumb } from './breadcrumbs'
import { DetailCards } from './detail-layout'
import { DetailGroups } from './detail-groups'
import { detailPlan, detailReadableField } from './detail-plan'
import { selectedReferenceRow } from './use-selected-references'
import { shortRecordId } from './labels'
import { GeneratedInlineEdit, type WriteRequest } from './write-screens'
const queryCodes = ['query_invalid', 'field_forbidden', 'relation_forbidden', 'query_too_expensive', 'entity_not_found', 'policy_violation'] as const
export { formatValue } from './labels'
export function signedValue(row: Record<string, any>, field: Field, value: ReactNode, locale: string): ReactNode {
  if (!field.ui?.signedBy || row[field.ui.signedBy.field] == null) return value
  const amount = Number(value)
  if (!Number.isFinite(amount)) return value
  const delta = row[field.ui.signedBy.field] === field.ui.signedBy.negativeValue ? -Math.abs(amount) : amount
  return <span className={delta < 0 ? 'text-red-700 tabular-nums font-medium' : 'text-green-700 tabular-nums font-medium'}>{new Intl.NumberFormat(locale, { signDisplay: 'always' }).format(delta)}</span>
}
interface ReadPageProps { calendarCreate?: (values: Record<string, string>) => void; write?: WriteRequest; onDenied?: () => void; contextList?: ReadQuery['contextList']; title?: string; embeddedCreate?: (entity: string, values: Record<string, string>) => ReactNode; model: Model; caps: Capabilities; orgId: string; entity: string; id?: string; request: (input: ReadQuery) => Promise<Result>; primaryAction?: { label: string; onAction: () => void }; actions?: (row?: Record<string, any>) => ReactNode; rowActions?: (row: Record<string, any>, disabled: boolean) => ReactNode }
export function GeneratedReadPage(props: ReadPageProps) { return props.id ? <GeneratedDetailPage {...props} /> : <GeneratedListPage {...props} /> }
function GeneratedDetailPage({ model, caps, orgId, entity, id, request, actions, embeddedCreate, write, onDenied }: ReadPageProps) {
  const { t, i18n } = useEntityTranslation(entity); const definition = model.entities[entity]
  const plan = detailPlan(model, entity, caps)
  const allowed = visibleEntities(model, caps).includes(entity)
  const query = allowed ? readQuery(model, entity, caps, { id }) : { entity, limit: 1, select: ['id'], where: { id: { eq: id } } }
  const result = useQuery({ queryKey: ['read', model.instance, orgId, caps.revision, entity, query, caps], queryFn: () => request(query), enabled: true })
  const record = result.data?.data[0]
  const breadcrumbStatus = !allowed || result.error ? 'unavailable' : result.isPending || result.isFetching ? 'pending' : record?.id === id ? 'ready' : 'unavailable'
  usePublishRecordBreadcrumb({ orgId, entity, id: id!, status: breadcrumbStatus, label: breadcrumbStatus === 'ready' ? breadcrumbRecordLabel(model, entity, record!, caps, i18n.language, t) : undefined })
  const includedFields = Object.keys(query.include ?? {}).map(name => definition.relations[name].field)
  const hydrated = useRelationLabels(model, entity, caps, orgId, plan ? [] : projection(model, entity, caps).filter(field => !includedFields.includes(field)), result.data?.data ?? [], request)
  const fieldLabel = (field: string) => t(`field_${field}`)
  const rowName = (target: string, row: Record<string, any>) => recordLabel(model, target, row, caps, i18n.language, t)
  const rowLink = (target: string, row: Record<string, any>, name = false) => <Link data-row-name={name ? '' : undefined} to="/o/$orgId/e/$entity/$id" params={{ orgId, entity: target, id: String(row.id) }}>{rowName(target, row)}</Link>
  const value = (row: Record<string, any>, field: string): ReactNode => {
    if (definition.fields[field].type === 'ref') {
      const label = row.__labels?.[field]
      if (label?.status === 'empty') return '—'
      if (label?.status === 'unavailable') return t('unavailableRecord')
    }
    const relation = Object.entries(definition.relations).find(([, relation]) => relation.cardinality === 'n:1' && relation.field === field)
    if (relation && Object.hasOwn(query.include ?? {}, relation[0])) {
      const related = row[relation[0]]; return related ? rowLink(relation[1].entity, related) : t('nullValue')
    }
    if (definition.fields[field].type === 'ref' && row[field] != null) {
      const projected = plan ? selectedReferenceRow(model, entity, field, row) : undefined
      const target = projected ? { entity: definition.fields[field].entity!, row: projected } : plan ? undefined : hydrated(field, row[field]); return target ? rowLink(target.entity, target.row) : t('unavailableRecord')
    }
    if (field === (caps.entities[entity]?.displayField ?? definition.displayField)) return rowName(entity, row)
    if (definition.fields[field].type === 'enum' && row[field] != null) return t(`value_${row[field]}`)
    return formatValue(row[field], definition.fields[field], i18n.language, t('yes'), t('no'), t('nullValue'))
  }
  const notFound = () => <ResourcePage title={t('notFound')}><p>{t('notFoundDescription')}</p><Link to="/organizations">{t('organizations')}</Link></ResourcePage>
  if ((result.error as { status?: number } | null)?.status === 403) return <ResourcePage title={t('forbidden')}><p>{t('resourceForbidden', { resource: t(`entity_${entity}`).toLocaleLowerCase(i18n.language) })}</p></ResourcePage>
  if (id && result.data && !result.data.data.length) return notFound()
  const code = (result.error as { code?: string } | null)?.code
  const error = result.error ? new Error(t(queryCodes.includes(code as any) ? `query_${code}` : 'requestFailed')) : null
  const readable = projection(model, entity, caps)
  if (id) {
    const row = result.data?.data[0]
    const edit = (field: string, content: ReactNode, label: string) => row && write ? <GeneratedInlineEdit key={field} model={model} caps={caps} orgId={orgId} entity={entity} request={request} write={write} onDenied={onDenied} row={row} field={field} label={label} value={content} refresh={async () => {
      const fresh = await result.refetch()
      if (fresh.error) throw fresh.error
      return fresh.data!
    }}>{content}</GeneratedInlineEdit> : content
    const informationTitle = t('detailInformation', { defaultValue: '', fallbackLng: false })
    const information = row && (plan ? <DetailGroups plan={plan} row={row} label={fieldLabel} value={field => value(row, field)} edit={edit} translate={key => t(key, { defaultValue: key })} /> : <DetailFields className="c2-detail border-0 p-0" fields={(definition.detail?.fields ?? readable.filter(field => !definition.fields[field].ui?.hidden)).filter(field => readable.includes(field) && !['id', 'organization_id'].includes(field)).map(field => ({ name: field, label: fieldLabel(field), value: edit(field, value(row, field), fieldLabel(field)) }))} />)
    return <DetailPage title={row ? rowName(entity, row) : t('loading')} backLink={<Button asChild variant="ghost" size="sm"><Link to="/o/$orgId/e/$entity" params={{ orgId, entity }}><svg aria-hidden="true" className="mr-2 size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7M5 12h14" /></svg>{t('backToList')}</Link></Button>} actions={row && actions?.(row)}>
      <QueryBoundary pending={result.isPending} error={error} loadingLabel={t('loading')}>{row && <>
        {readable.includes('id') && <dl className="generated-technical mb-4 text-sm text-muted-foreground"><dt>{fieldLabel('id')}</dt><dd className="break-all font-mono">{String(row.id)}</dd></dl>}
        {definition.detail?.metrics && <dl className="generated-metrics">{(plan?.metrics ?? definition.detail.metrics.filter(metric => readable.includes(metric.field))).map(metric => <div key={metric.field}>
          <dt>{fieldLabel(metric.field)}</dt><dd className={metric.tone === 'positive' ? 'text-green-700' : metric.tone === 'negative' ? 'text-red-700' : ''}>{value(row, metric.field)}{metric.unitField && readable.includes(metric.unitField) && <span className="generated-metric-unit"> {row[metric.unitField]}</span>}</dd>
        </div>)}</dl>}
        <DetailCards sections={definition.detail?.sections} cards={[
          { key: 'info', content: <Card className="min-w-0">{informationTitle && <CardHeader><CardTitle>{informationTitle}</CardTitle></CardHeader>}<CardContent>{information}</CardContent></Card> },
          ...(plan?.relations ?? readableRelations(model, entity, caps).filter(([, relation]) => relation.cardinality === '1:n' || (separateRelations(model) || definition.detail || Object.values(definition.relations).some(relation => relation.through)) && !(definition.detail?.fields ?? readable).includes(relation.field))).filter(([name]) => !definition.detail?.lists?.[name]).map(([name, relation]) => ({ key: name, content: <SeparateRelation model={model} caps={caps} orgId={orgId} entity={entity} name={name} row={row} request={request} link={related => rowLink(relation.entity, related)} /> })),
          ...Object.entries(definition.detail?.lists ?? {}).filter(([, list]) => caps.entities[list.entity]?.operations.includes('read') && caps.entities[list.entity]?.readable.includes('id') && caps.entities[list.entity]?.readable.includes(list.bind.field)).map(([name, list]) => ({ key: name, content: <ContextList key={`${entity}/${row.id}/${name}`} model={model} caps={caps} orgId={orgId} entity={entity} id={String(row.id)} name={name} request={request} create={embeddedCreate} /> })),
          ...Object.entries(query.include ?? {}).map(([name, selection]) => { const relation = definition.relations[name]; const rows = row[name] ? Array.isArray(row[name]) ? row[name] : [row[name]] : []
          return { key: name, content: <Card className="c2-relations"><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><h2>{t(`relation_${name}`)}</h2><Badge variant="secondary">{rows.length}{relation.cardinality === '1:n' && rows.length >= (selection.limit ?? Infinity) ? '+' : ''}</Badge></CardTitle></CardHeader><CardContent className="space-y-3">{rows.length ? <ul>{rows.map((related: Record<string, any>) => <li key={related.id}>{rowLink(relation.entity, related)}</li>)}</ul> : <p>{relationEmptyText(entity, name, relation.through?.entity ?? relation.entity, t)}</p>}{relation.cardinality === '1:n' && <p>{t('relatedLimit', { count: selection.limit })}</p>}</CardContent></Card> }
        })]} />
      </>}</QueryBoundary>
    </DetailPage>
  }
  return notFound()
}

function GeneratedListPage({ model, caps, orgId, entity, request, actions, rowActions, primaryAction, contextList, title, calendarCreate }: ReadPageProps) {
  const { t, i18n } = useEntityTranslation(entity); const navigate = useNavigate()
  const definition = model.entities[entity]
  const [searchPending, setSearchPending] = useState(false)
  const list = useGeneratedList({ model, caps, orgId, entity, request, contextList })
  const readable = projection(model, entity, caps)
  const display = caps.entities[entity]?.displayField ?? definition.displayField
  const configured = definition.list?.columns ?? definition.listColumns
  const defaultPrimary = display && readable.includes(display) && definition.fields[display] ? display : 'id'
  // Explicit columns own the order; only automatically derived columns promote the display field.
  const listFields = [...new Set(configured ?? [defaultPrimary, ...definition.columns])].filter(field => readable.includes(field) || !!definition.list?.relatedColumns?.[field] && readable.includes(definition.list.relatedColumns[field].via))
  const primary = listFields[0]
  const rows = list.data?.data ?? []
  const setFilter = (field: string, predicate?: Record<string, unknown>) => list.onStateChange({ ...list.state, userFilters: [...list.state.userFilters.filter(filter => filter.field !== field), ...(predicate ? [{ field, predicate }] : [])] }, 'filter')
  const chips = list.state.userFilters.map(filter => {
    const spec = definition.fields[filter.field]; const mapping = filterMapping(filterKind(model, entity, filter.field, caps)!, spec, i18n.language)
    const value = mapping.fromPredicate(filter.predicate)
    const label = mapping.label(value, key => {
      if (spec.type === 'ref') return key
      return t(spec.type === 'enum' ? `value_${key}` : key, { defaultValue: key })
    })
    const column = t(`field_${filter.field}`)
    return { id: filter.field, column, value: label, removeLabel: t('removeFilter', { column, value: label }), onRemove: () => setFilter(filter.field) }
  })
  const views = definition.list?.views?.filter(view => readableWhere(view.where, model, entity, caps)) ?? []

  const sortable = sortableFields(model, entity, caps)
  const fieldValue = (row: Record<string, any>, field: string): ReactNode => {
    if (field === 'id') return <span title={String(row.id)}>{shortRecordId(row.id)}</span>
    const spec = definition.fields[field]
    if (definition.list?.relatedColumns?.[field] || spec?.type === 'ref') {
      const target = row.__labels?.[field]
      if (!target) return <span aria-label={t('loading')}>{t('loading')}</span>
      if (target.status === 'empty') return '—'
      if (target.status === 'unavailable') return t('unavailableRecord')
      const label = recordLabel(model, target.entity, target.row, caps, i18n.language, t)
      return <Link to="/o/$orgId/e/$entity/$id" params={{ orgId, entity: target.entity, id: String(target.row.id) }}>{label}</Link>
    }
    if (field === display) return recordLabel(model, entity, row, caps, i18n.language, t)
    if (row[field] == null) return '—'
    if (spec.type === 'enum' && row[field] != null) return t(`value_${row[field]}`)
    return spec.ui?.signedBy && row[field] != null ? signedValue(row, spec, row[field], i18n.language) : formatValue(row[field], spec, i18n.language, t('yes'), t('no'), t('nullValue'))
  }
  const error = list.result.error as { status?: number; code?: string } | null
  const Page = contextList ? EmbeddedListCard : ResourcePage
  if (error?.status === 403) return <Page title={title ?? t('forbidden')}><p>{t('resourceForbidden', { resource: t(`entity_${entity}`).toLocaleLowerCase(i18n.language) })}</p></Page>
  return <Page count={contextList && list.result.isSuccess ? `${rows.length}${list.data?.next_cursor ? '+' : ''}` : undefined} title={title ?? t('pageTitle', { defaultValue: t(`entity_${entity}`), fallbackLng: false })} actionLabel={primaryAction?.label} onAction={primaryAction?.onAction} actions={<>{listSearchableFields(model, entity, caps, list.state.presentation).length > 0 && <DataTableSearch value={list.state.search} onChange={search => list.onStateChange({ ...list.state, search }, 'search')} label={t('search')} clearLabel={t('clearSearch')} onPendingChange={setSearchPending} description={t('searchAllColumns')} />}{actions?.()}</>}>
    {listSearchableFields(model, entity, caps, list.state.presentation).join() === 'id' && <p className="text-sm text-muted-foreground">{t('searchById')}</p>}
    {list.notice && <p role="status" className="my-2 text-sm">{t(list.notice)}</p>}
    {error?.code === 'query_too_expensive' && list.undo && <PrimitiveButton variant="outline" onClick={list.undo}>{t('undoLastChange')}</PrimitiveButton>}
    {views.length > 0 && <div role="group" aria-label={t('listViews')} className="flex flex-wrap gap-2 py-2">{[{ id: 'all', label: 'viewAll' }, ...views].map(view => <PrimitiveButton key={view.id} className="border border-transparent aria-pressed:border-foreground aria-pressed:font-semibold" variant={(list.state.view ?? 'all') === view.id ? 'secondary' : 'ghost'} aria-pressed={(list.state.view ?? 'all') === view.id} onClick={() => list.onStateChange({ ...list.state, view: view.id }, 'view')}>{t(view.label)}</PrimitiveButton>)}</div>}
    {availableCalendar(model, entity, caps) && <div role="group" aria-label={t('listPresentation')} className="flex flex-wrap gap-2 py-2">{(['table', 'calendar'] as const).map(presentation => <PrimitiveButton key={presentation} variant={list.state.presentation === presentation ? 'secondary' : 'ghost'} aria-pressed={list.state.presentation === presentation} onClick={() => list.onStateChange({ ...list.state, presentation }, 'view')}>{t(`${presentation}View`)}</PrimitiveButton>)}</div>}
    <DataTableActiveFilters filters={chips} label={t('activeFilters')} clearLabel={t('clearAllFilters')} onClear={() => list.onStateChange({ ...list.state, userFilters: [] }, 'filter')} />
    {list.state.presentation === 'calendar' ? <>
      <div className="flex flex-wrap gap-2" aria-label={t('activeFilters')}>{listFields.map(field => <div key={field} className="flex items-center rounded-md border pl-2 text-xs"><span>{t(`field_${field}`)}</span><HeaderFilter model={model} caps={caps} orgId={orgId} entity={entity} field={field} request={request} predicate={list.state.userFilters.find(filter => filter.field === field)?.predicate} onChange={predicate => setFilter(field, predicate)} /></div>)}</div>
      <EntityCalendar model={model} entity={entity} caps={caps} orgId={orgId} state={list.state} data={list.data} pending={list.result.isFetching} error={error ? t(queryCodes.includes(error.code as any) ? `query_${error.code}` : 'requestFailed') : undefined} onChange={state => list.onStateChange(state, 'view')} onCreate={calendarCreate} onPage={list.onPage} previous={list.page > 0} />
    </> : <div className="caption-bottom"><DataTable compact={definition.list?.compact} mobileCards={definition.list?.mobileCards} rows={rows} columns={[
      ...listFields.map((field, index) => ({ id: field, label: field === 'id' || field === primary ? t(`field_${field}`) : t(`listField_${field}`, { defaultValue: t(`field_${field}`) }), sortable: sortable.includes(field), filter: <HeaderFilter model={model} caps={caps} orgId={orgId} entity={entity} field={field} request={request} predicate={list.state.userFilters.find(filter => filter.field === field)?.predicate} onChange={predicate => setFilter(field, predicate)} />, cell: (row: Record<string, any>) => index === 0 ? <Link data-row-name="" title={String(row.id)} to="/o/$orgId/e/$entity/$id" params={{ orgId, entity, id: String(row.id) }}>{fieldValue(row, field)}</Link> : fieldValue(row, field) })),
      ...(rowActions && hasRowActions(model, entity, caps) ? [{ id: '_actions', label: t('actions'), cell: (row: Record<string, any>) => <>{rowActions!(row, list.stale || list.result.isFetching || searchPending)}</> }] : []),
    ]} state={list.state} onStateChange={list.onStateChange} page={list.page} range={list.range} onPage={list.onPage} nextCursor={error ? null : list.data?.next_cursor} isFetching={list.result.isFetching} error={error ? new Error(t(queryCodes.includes(error.code as any) ? `query_${error.code}` : 'requestFailed')) : null}
      label={t(`entity_${entity}`)} labels={{ error: t('requestFailed'), search: t('search'), clearSearch: t('clearSearch'), noResults: list.result.isPending ? t('loading') : t('noResults'), previous: t('previousPage'), next: t('nextPage'), previousText: t('paginationPrevious'), nextText: t('paginationNext'), pageSizeOption: size => t('paginationSize', { count: size }), pageSize: t('rowsPerPage'), sort: column => t('sortColumn', { column }), sortAndFilter: t('sortAndFilter'), sortStates: { asc: t('sortAscending'), desc: t('sortDescending'), none: t('sortNone') }, range: (start, end) => t('listRange', { start: new Intl.NumberFormat(i18n.language).format(start), end: new Intl.NumberFormat(i18n.language).format(end) }) }}
      staleLabel={list.stale ? t('listRowsStale') : undefined}
      clearFilters={t('clearSearchFilters')} onClearFilters={list.state.search || chips.length ? () => list.onStateChange({ ...list.state, search: '', userFilters: [] }, 'filter') : undefined}
      searchAvailable={false} pendingSearch={searchPending}
      searchDescription={t('searchAllColumns')}
      onRowClick={row => { void navigate({ to: '/o/$orgId/e/$entity/$id', params: { orgId, entity, id: String(row.id) } }) }} /></div>}
  </Page>
}

/** Independent cursor per relation; no combined includes, per-parent loops or raised caps. */
function SeparateRelation({ model, caps, orgId, entity, name, row, request, link }: { model: Model; caps: Capabilities; orgId: string; entity: string; name: string; row: Record<string, any>; request: (input: ReadQuery) => Promise<Result>; link: (row: Record<string, any>) => ReactNode }) {
  const { t } = useEntityTranslation(entity); const relation = model.entities[entity].relations[name]
  const enabled = relation.cardinality === '1:n' || row[relation.field] != null
  const result = useInfiniteQuery({ queryKey: ['read', model.instance, orgId, caps.revision, entity, row.id, name, caps], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => request(relationQuery(model, entity, name, row, caps, pageParam)), getNextPageParam: page => page.next_cursor ?? undefined, enabled })
  const rows = result.data?.pages.flatMap(page => page.data) ?? []
  const count = relation.through ? new Set(rows.map(related => related[relation.through!.field])).size : rows.length
  return <Card className="c2-relations"><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><h2>{t(`relation_${name}`)}</h2><Badge variant="secondary">{enabled && result.isPending ? '…' : result.isError ? '—' : `${count}${result.hasNextPage ? '+' : ''}`}</Badge></CardTitle>{t(`relationDescription_${name}`, { defaultValue: '', fallbackLng: false }) && <CardDescription>{t(`relationDescription_${name}`)}</CardDescription>}</CardHeader><CardContent className="space-y-3"><QueryBoundary pending={enabled && result.isPending} error={result.error ? new Error(t('requestFailed')) : null} loadingLabel={t('loading')}>
    {rows.length ? relation.through ? <ManyRelationLinks model={model} caps={caps} orgId={orgId} relation={relation} rows={rows} request={request} /> : model.entities[entity].detail?.relations?.[name] ? <RelationRecords model={model} caps={caps} orgId={orgId} request={request} entity={relation.entity} rows={rows} columns={model.entities[entity].detail!.relations![name].columns.filter(field => !model.entities[entity].detail?.groups || caps.entities[relation.entity]?.readable.includes(field) && (field !== model.entities[relation.entity].displayField || !model.entities[relation.entity].labelDependencies || detailReadableField(model, relation.entity, caps, field)))} /> : <ul>{rows.map(related => <li key={related.id}>{link(related)}</li>)}</ul> : <p>{relationEmptyText(entity, name, relation.through?.entity ?? relation.entity, t)}</p>}
    {relation.cardinality === '1:n' && (result.hasNextPage || !model.entities[entity].detail) && <Button variant="outline" disabled={!result.hasNextPage || result.isFetching} onClick={() => { void result.fetchNextPage() }}>{t('loadMore')}</Button>}
  </QueryBoundary></CardContent></Card>
}

/** Never inherit the owning entity's noResults context for a related collection. */
export function relationEmptyText(entity: string, name: string, target: string, t: (key: string, options?: any) => string) {
  return t(relationEmptyKey(entity, name), { context: '', defaultValue: t('relationEmpty', { context: name, defaultValue: t('relationEmptyFallback', { context: '', entity: t(`entity_${target}`, { context: '' }) }) }) })
}
function ManyRelationLinks({ model, caps, orgId, relation, rows, request }: { model: Model; caps: Capabilities; orgId: string; relation: import('./read').Relation; rows: Record<string, any>[]; request: (query: ReadQuery) => Promise<Result> }) {
  const { t, i18n } = useEntityTranslation(relation.through!.entity)
  const related = useRelationLabels(model, relation.entity, caps, orgId, [relation.through!.field], rows, request)
  return <ul>{[...new Map(rows.map(row => [row[relation.through!.field], row])).values()].map(row => {
    const target = related(relation.through!.field, row[relation.through!.field])
    const label = target ? recordLabel(model, target.entity, target.row, caps, i18n.language, t) : t('unavailableRecord')
    return <li key={row[relation.through!.field]}>{target ? <Link to="/o/$orgId/e/$entity/$id" params={{ orgId, entity: target.entity, id: target.row.id }}>{label}</Link> : label}</li>
  })}</ul>
}

function RelationRecords({ model, caps, orgId, request, entity, rows, columns }: { model: Model; caps: Capabilities; orgId: string; request: (query: ReadQuery) => Promise<Result>; entity: string; rows: Record<string, any>[]; columns: string[] }) {
  const { t, i18n } = useEntityTranslation(entity)
  const definition = model.entities[entity]
  const visible = columns.filter(field => caps.entities[entity]?.readable.includes(field))
  const related = useRelationLabels(model, entity, caps, orgId, visible, rows, request)
  const cell = (row: Record<string, any>, field: string) => {
    if (field === 'id') return <span title={String(row.id)}>{shortRecordId(row.id)}</span>
    const spec = definition.fields[field]
    if (spec.type === 'ref' && row.__labels?.[field]?.status === 'unavailable') return t('unavailableRecord')
    if (spec.type === 'ref' && row[field] != null) {
      const target = related(field, row[field])
      return target ? <Link to="/o/$orgId/e/$entity/$id" params={{ orgId, entity: target.entity, id: String(target.row.id) }}>{recordLabel(model, target.entity, target.row, caps, i18n.language, t)}</Link> : t('unavailableRecord')
    }
    if (row[field] == null) return '—'
    if (field === definition.displayField && row[field] != null) return <Link to="/o/$orgId/e/$entity/$id" params={{ orgId, entity, id: String(row.id) }}>{recordLabel(model, entity, row, caps, i18n.language, t)}</Link>
    if (spec.ui?.signedBy && row[field] != null && caps.entities[entity]?.readable.includes(spec.ui.signedBy.field)) return signedValue(row, spec, row[field], i18n.language)
    return spec.type === 'enum' && row[field] != null ? t(`value_${row[field]}`) : formatValue(row[field], spec, i18n.language, t('yes'), t('no'), t('nullValue'))
  }
  return <div className="generated-related-records">
    <table className="generated-relation-table"><thead><tr>{visible.map(field => <th key={field} scope="col">{t(`field_${field}`)}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>{visible.map(field => <td key={field}>{cell(row, field)}</td>)}</tr>)}</tbody></table>
    <ul className="generated-relation-cards">{rows.map(row => <li key={row.id}><dl>{visible.map(field => <div key={field}><dt>{t(`field_${field}`)}</dt><dd>{cell(row, field)}</dd></div>)}</dl></li>)}</ul>
  </div>
}

/** Same generated list surface, with state isolated from the containing page and siblings. */
export function ContextList({ model, caps, orgId, entity, id, name, request, create }: { model: Model; caps: Capabilities; orgId: string; entity: string; id: string; name: string; request: (input: ReadQuery) => Promise<Result>; create?: ReadPageProps['embeddedCreate'] }) {
  const list = model.entities[entity]?.detail?.lists?.[name]
  const { t } = useEntityTranslation(entity)
  if (!list || !caps.entities[entity]?.operations.includes('read') || !caps.entities[entity]?.readable.includes('id') || !caps.entities[list.entity]?.operations.includes('read') || !caps.entities[list.entity]?.readable.includes('id') || !caps.entities[list.entity]?.readable.includes(list.bind.field)) return null
  const target = model.entities[list.entity]
  const configured = { ...model, entities: { ...model.entities, [list.entity]: { ...target, list: { ...target.list, ...(list.columns ? { columns: list.columns } : {}), compact: true, mobileCards: target.list?.mobileCards ?? true } } } }
  return <GeneratedListPage key={`${model.instance}/${orgId}/${entity}/${id}/${name}/${caps.revision}`} model={configured} caps={caps} orgId={orgId} entity={list.entity} request={request} contextList={{ entity, id, list: name }} title={t(list.label, { defaultValue: list.label })} actions={() => list.create && create?.(list.entity, { [list.bind.field]: id })} />
}
function EmbeddedListCard({ title, actions, children, count }: { title: string; actions?: ReactNode; children?: ReactNode; count?: string; actionLabel?: string; onAction?: () => void }) {
  return <Card className="c2-relations min-w-0" data-context-list=""><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><h2>{title}</h2>{count !== undefined && <Badge variant="secondary">{count}</Badge>}</CardTitle><div className="flex flex-wrap items-center gap-2">{actions}</div></CardHeader><CardContent className="min-w-0">{children}</CardContent></Card>
}
