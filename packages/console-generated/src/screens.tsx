import { listColumnAlignment } from './list-presentation'
import { GeneratedListCell } from './list-cell'
import { accountLinkField, accountLinkRelation } from './account-link'
import { EntityCalendar } from './calendar'
import { availableCalendar } from './calendar-model'
import { relationEmptyKey } from './many-to-many'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEntityTranslation } from './entity-translation'
import { Button, DataTable, DataTableSearch, DataTableActiveFilters, DetailFields, DetailPage, ResourcePage, QueryBoundary, ListPageComposition, ListViewTabs, ListPageFooter } from '@workbasehq/ui'
import { recordLabel, formatValue, projection, readQuery, relationQuery, readableRelations, separateRelations, listSearchableFields, visibleEntities, type Capabilities, type Model, type ReadQuery, type Result, type Field } from './read'
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@workbasehq/ui/components/ui/card'
import { Badge } from '@workbasehq/ui/components/ui/badge'
import { Button as PrimitiveButton } from '@workbasehq/ui/components/ui/button'
import { useGeneratedList, useRelationLabels } from './useGeneratedList'
import { filterMapping } from './filter-kinds'
import { FilterPanel } from './filter-panel'
import { HeaderFilter, ToolbarFilter } from './header-filter'
import { readableWhere, searchFromState, sortableFields } from './list-model'
import { SavedViewsControls } from './saved-views-controls'
import { DisplayMenu } from './display-menu'
import { restoreSavedView, savedFingerprint, type SavedViewsScope } from './saved-views'
import { hasRowActions } from './write'
import { breadcrumbRecordLabel, usePublishRecordBreadcrumb } from './breadcrumbs'
import { DetailCards } from './detail-layout'
import { DetailGroups } from './detail-groups'
import { detailPlan, detailReadableField } from './detail-plan'
import { selectedReferenceRow } from './use-selected-references'
import { shortRecordId } from './labels'
import { useScopeHome } from './scope-home'
import { teardownScope, useReferenceAuthority, type ListOwner } from './reference-authority'
import { canReadApplicationAccess, ApplicationAccessCard, GeneratedRowInvitation, GeneratedInlineEdit, type WriteRequest } from './write-screens'
const queryCodes = ['query_invalid', 'field_forbidden', 'relation_forbidden', 'query_too_expensive', 'entity_not_found', 'policy_violation'] as const
export { formatValue } from './labels'
export function signedValue(row: Record<string, any>, field: Field, value: ReactNode, locale: string): ReactNode {
  if (!field.ui?.signedBy || row[field.ui.signedBy.field] == null) return value
  const amount = Number(value)
  if (!Number.isFinite(amount)) return value
  const delta = row[field.ui.signedBy.field] === field.ui.signedBy.negativeValue ? -Math.abs(amount) : amount
  return <span className={delta < 0 ? 'text-red-700 tabular-nums font-medium' : 'text-green-700 tabular-nums font-medium'}>{new Intl.NumberFormat(locale, { signDisplay: 'always' }).format(delta)}</span>
}
interface ReadPageProps { unavailable?: ReactNode; savedViewsScope?: SavedViewsScope; calendarCreate?: (values: Record<string, string>) => void; write?: WriteRequest; onDenied?: () => void; contextList?: ReadQuery['contextList']; title?: string; embeddedCreate?: (entity: string, values: Record<string, string>) => ReactNode; model: Model; caps: Capabilities; orgId: string; entity: string; id?: string; request: (input: ReadQuery) => Promise<Result>; primaryAction?: { label: string; onAction: () => void }; actions?: (row?: Record<string, any>, blocked?: boolean) => ReactNode; rowActions?: (row: Record<string, any>, disabled: boolean) => ReactNode }
export function GeneratedReadPage(props: ReadPageProps) {
  const authority = useReferenceAuthority()
  // An unknown host actor has no verified namespace for identity-bearing reads.
  if (props.id && props.unavailable !== undefined) return props.unavailable
  if (props.id && authority && authority.actor === undefined) return null
  return props.id ? <GeneratedDetailPage key={JSON.stringify([props.model.instance, authority?.actor, props.orgId, props.entity, props.id])} {...props} /> : <GeneratedListPage {...props} />
}
function GeneratedDetailPage({ model, caps, orgId, entity, id, request, actions, embeddedCreate, write, onDenied }: ReadPageProps) {
  const home = useScopeHome()
  const authority = useReferenceAuthority()
  const { t, i18n } = useEntityTranslation(entity); const definition = model.entities[entity]
  const plan = detailPlan(model, entity, caps)
  const allowed = visibleEntities(model, caps).includes(entity)
  const query = allowed ? readQuery(model, entity, caps, { id }) : { entity, limit: 1, select: ['id'], where: { id: { eq: id } } }
  const result = useQuery({ queryKey: ['read', model.instance, authority?.actor, authority?.observedAt, orgId, caps.revision, entity, query, caps], queryFn: () => request(query), enabled: true })
  const retained = useRef<Record<string, any> | undefined>(undefined)
  const record = result.data?.data[0]
  if (!result.isFetching && !result.error && record?.id === id) retained.current = record
  const blocked = result.isPending || result.isFetching || !!result.error || !allowed || record?.id !== id
  const actionRow = !result.error && allowed ? record ?? retained.current : undefined
  const breadcrumbStatus = !allowed || result.error ? 'unavailable' : result.isPending || result.isFetching ? 'pending' : record?.id === id ? 'ready' : 'unavailable'
  usePublishRecordBreadcrumb({ orgId, entity, id: id!, status: breadcrumbStatus, label: breadcrumbStatus === 'ready' ? breadcrumbRecordLabel(model, entity, record!, caps, i18n.language, t) : undefined })
  const includedFields = Object.keys(query.include ?? {}).map(name => definition.relations[name].field)
  const hydrated = useRelationLabels(model, entity, caps, orgId, plan ? [] : projection(model, entity, caps).filter(field => !accountLinkField(model, entity, field) && !includedFields.includes(field)), result.data?.data ?? [], request)
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
    return formatValue(row[field], definition.fields[field], i18n.language, t('yes'), t('no'), t('nullValue'), model.timeZone)
  }
  const notFound = () => <ResourcePage title={t('notFound')}><p>{t('notFoundDescription')}</p><Link to={home}>{t(home === '/organizations' ? 'organizations' : 'overview')}</Link></ResourcePage>
  if (!allowed) return <ResourcePage title={t('forbidden')}>{t('forbiddenDescription')}</ResourcePage>
  if ((result.error as { status?: number } | null)?.status === 403) return <ResourcePage title={t('forbidden')}><p>{t('resourceForbidden', { resource: t(`entity_${entity}`).toLocaleLowerCase(i18n.language) })}</p></ResourcePage>
  if (id && result.data && !result.data.data.length) return notFound()
  const code = (result.error as { code?: string } | null)?.code
  const error = result.error ? new Error(t(queryCodes.includes(code as any) ? `query_${code}` : 'requestFailed')) : null
  const readable = projection(model, entity, caps).filter(field => !accountLinkField(model, entity, field))
  if (result.error) return <ResourcePage title={t('requestFailed')}><p role="alert">{error?.message}</p></ResourcePage>
  if (id) {
    const row = actionRow
    const edit = (field: string, content: ReactNode, label: string) => row && write ? <GeneratedInlineEdit key={field} model={model} caps={caps} orgId={orgId} entity={entity} request={request} write={write} onDenied={onDenied} readBlocked={blocked} row={row} field={field} label={label} value={content} refresh={async () => {
      const fresh = await result.refetch()
      if (fresh.error) throw fresh.error
      return fresh.data!
    }}>{content}</GeneratedInlineEdit> : content
    const informationTitle = t('detailInformation', { defaultValue: '', fallbackLng: false })
    const information = row && (plan ? <DetailGroups plan={plan} row={row} label={fieldLabel} value={field => value(row, field)} edit={edit} translate={key => t(key, { defaultValue: key })} /> : <DetailFields className="c2-detail border-0 p-0" fields={(definition.detail?.fields ?? readable.filter(field => !definition.fields[field].ui?.hidden)).filter(field => readable.includes(field) && !['id', 'organization_id'].includes(field)).map(field => ({ name: field, label: fieldLabel(field), value: edit(field, value(row, field), fieldLabel(field)) }))} />)
    return <DetailPage title={row ? rowName(entity, row) : t('loading')} backLink={<Button asChild variant="ghost" size="sm"><Link to="/o/$orgId/e/$entity" params={{ orgId, entity }}><svg aria-hidden="true" className="mr-2 size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7M5 12h14" /></svg>{t('backToList')}</Link></Button>} actions={row && actions?.(row, blocked)}>
      <QueryBoundary pending={result.isPending && !row} error={error} loadingLabel={t('loading')}>{row && <>
        {readable.includes('id') && <dl className="generated-technical mb-4 text-sm text-muted-foreground"><dt>{fieldLabel('id')}</dt><dd className="break-all font-mono">{String(row.id)}</dd></dl>}
        {definition.detail?.metrics && <dl className="generated-metrics">{(plan?.metrics ?? definition.detail.metrics.filter(metric => readable.includes(metric.field))).map(metric => <div key={metric.field}>
          <dt>{fieldLabel(metric.field)}</dt><dd className={metric.tone === 'positive' ? 'text-green-700' : metric.tone === 'negative' ? 'text-red-700' : ''}>{value(row, metric.field)}{metric.unitField && readable.includes(metric.unitField) && <span className="generated-metric-unit"> {row[metric.unitField]}</span>}</dd>
        </div>)}</dl>}
        <DetailCards sections={definition.detail?.sections} cards={[
          { key: 'info', content: <Card className="min-w-0">{informationTitle && <CardHeader><CardTitle>{informationTitle}</CardTitle></CardHeader>}<CardContent>{information}</CardContent></Card> },
          ...(definition.accountLink && canReadApplicationAccess(caps) ? [{ key: '_row_access', content: <ApplicationAccessCard readBlocked={blocked} model={model} caps={caps} orgId={orgId} entity={entity} request={request} write={write} onDenied={onDenied} row={row} /> }] : []),
          ...(plan?.relations ?? readableRelations(model, entity, caps).filter(([, relation]) => relation.cardinality === '1:n' || (separateRelations(model) || definition.detail || Object.values(definition.relations).some(relation => relation.through)) && !(definition.detail?.fields ?? readable).includes(relation.field))).filter(([name, relation]) => !accountLinkRelation(model, entity, relation) && !definition.detail?.lists?.[name]).map(([name, relation]) => ({ key: name, content: <SeparateRelation model={model} caps={caps} orgId={orgId} entity={entity} name={name} row={row} request={request} link={related => rowLink(relation.entity, related)} /> })),
          ...Object.entries(definition.detail?.lists ?? {}).filter(([, list]) => caps.entities[list.entity]?.operations.includes('read') && caps.entities[list.entity]?.readable.includes('id') && caps.entities[list.entity]?.readable.includes(list.bind.field)).map(([name, list]) => ({ key: name, content: <ContextList key={`${entity}/${row.id}/${name}`} model={model} caps={caps} orgId={orgId} entity={entity} id={String(row.id)} name={name} request={request} create={embeddedCreate} /> })),
          ...Object.entries(query.include ?? {}).filter(([name]) => !accountLinkRelation(model, entity, definition.relations[name])).map(([name, selection]) => { const relation = definition.relations[name]; const rows = row[name] ? Array.isArray(row[name]) ? row[name] : [row[name]] : []
          return { key: name, content: <Card className="c2-relations"><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><h2>{t(`relation_${name}`)}</h2><Badge variant="secondary">{rows.length}{relation.cardinality === '1:n' && rows.length >= (selection.limit ?? Infinity) ? '+' : ''}</Badge></CardTitle></CardHeader><CardContent className="space-y-3">{rows.length ? <ul>{rows.map((related: Record<string, any>) => <li key={related.id}>{rowLink(relation.entity, related)}</li>)}</ul> : <p>{relationEmptyText(entity, name, relation.through?.entity ?? relation.entity, t)}</p>}{relation.cardinality === '1:n' && <p>{t('relatedLimit', { count: selection.limit })}</p>}</CardContent></Card> }
        })]} />
      </>}</QueryBoundary>
    </DetailPage>
  }
  return notFound()
}

/**
 * Owns the lifetime of a list's state. When the verified actor or the org/instance changes, the whole body is
 * replaced (draft panel, saved-view selection, display preference, confirmed URL state) and the previous scope's
 * cached rows, counts, totals and access identities are removed. An actor that is merely being established
 * (unknown -> known) keeps a deep-linked state.
 */
function GeneratedListPage(props: ReadPageProps) {
  const client = useQueryClient()
  const authority = useReferenceAuthority()
  const actor = authority?.actor
  const [scope, setScope] = useState<{ owner: ListOwner; generation: number; discard: boolean; previous?: ListOwner }>({ owner: { instance: props.model.instance, orgId: props.orgId, actor }, generation: 0, discard: false })
  // `owner.actor` is the last verified actor: a transient unknown actor is not a change, but A -> unknown -> B is.
  const moved = scope.owner.instance !== props.model.instance || scope.owner.orgId !== props.orgId || actor !== undefined && scope.owner.actor !== undefined && scope.owner.actor !== actor
  if (moved) {
    // Render-phase transition: React re-renders before committing, so no child ever shows the old scope with the new one.
    setScope(old => ({ owner: { instance: props.model.instance, orgId: props.orgId, actor }, generation: old.generation + 1, discard: true, previous: old.owner }))
  } else if (actor !== undefined && scope.owner.actor === undefined) setScope(old => ({ ...old, owner: { ...old.owner, actor } }))
  useEffect(() => {
    if (!scope.previous) return
    teardownScope(client, scope.previous)
    setScope(old => old.previous === scope.previous ? { ...old, previous: undefined } : old)
  }, [client, scope.previous])
  // Keep ownership above the host's error UI, while unmounting all identity-bearing content.
  if (props.unavailable !== undefined) return props.unavailable
  // The incoming body can mount only after the outgoing cache teardown has committed.
  if (moved || scope.previous || authority && actor === undefined) return null
  return <ListPageBody key={scope.generation} {...props} discard={scope.discard} onDiscarded={() => setScope(old => old.discard ? { ...old, discard: false } : old)} />
}
function ListPageBody({ discard, onDiscarded, savedViewsScope, model, caps, orgId, entity, request, actions, rowActions, primaryAction, contextList, title, calendarCreate, write, onDenied }: ReadPageProps & { discard: boolean; onDiscarded: () => void }) {
  const { t, i18n } = useEntityTranslation(entity); const navigate = useNavigate()
  const definition = model.entities[entity]
  const [searchPending, setSearchPending] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  // Session-local display preference: separate from the query, counts, URL and personal views.
  const [visibility, setVisibility] = useState<Record<string, boolean>>({})
  const [columnOrder, setColumnOrder] = useState<string[]>([])
  const [compactPreference, setCompactPreference] = useState<boolean>()
  const list = useGeneratedList({ model, caps, orgId, entity, request, contextList, discard, onDiscarded })
  const readable = projection(model, entity, caps)
  const display = caps.entities[entity]?.displayField ?? definition.displayField
  const configured = definition.list?.columns?.map(column => column.field) ?? definition.listColumns
  const defaultPrimary = display && readable.includes(display) && definition.fields[display] ? display : 'id'
  // Explicit columns own the order; only automatically derived columns promote the display field.
  const listFields = [...new Set(configured ?? [defaultPrimary, ...definition.columns])].filter(field => readable.includes(field) || !!definition.list?.relatedColumns?.[field] && readable.includes(definition.list.relatedColumns[field].via))
  const primary = listFields[0]
  const rows = list.data?.data ?? []
  const setFilter = (field: string, predicate?: Record<string, unknown>) => list.onStateChange({ ...list.state, userFilters: [...list.confirmedState.userFilters.filter(filter => filter.field !== field), ...(predicate ? [{ field, predicate }] : [])] }, 'filter')
  const relationFilters = list.filters.filter(filter => filter.kind === 'relation')
  const selectedLabels = useRelationLabels(model, entity, caps, orgId, relationFilters.map(filter => filter.field), list.state.userFilters.flatMap(filter => Array.isArray(filter.predicate.in) ? filter.predicate.in.map(id => ({ [filter.field]: id })) : []), request)
  const chips = list.state.userFilters.flatMap(filter => {
    const descriptor = list.filters.find(descriptor => descriptor.field === filter.field)
    if (!descriptor) return []
    const spec = definition.fields[filter.field]; const mapping = filterMapping(descriptor.kind, spec, i18n.language, descriptor.operators, model.timeZone)
    const value = mapping.fromPredicate(filter.predicate)
    const label = mapping.label(value, key => {
      if (descriptor.kind === 'relation') { const record = selectedLabels(filter.field, key); return record ? recordLabel(model, record.entity, record.row, caps, i18n.language, t) : t('unavailableRecord') }
      if (spec?.type === 'ref') return key
      return t(spec?.type === 'enum' ? `value_${key}` : key, { defaultValue: key })
    })
    const column = descriptor.label ?? t(`field_${filter.field}`)
    return [{ id: filter.field, column, value: label, removeLabel: t('removeFilter', { column, value: label }), onRemove: () => setFilter(filter.field) }]
  })
  if (list.state.rowAccess) {
    const column = t('rowAccessFilter'), value = t(`rowAccess_${list.state.rowAccess}`)
    chips.push({ id: '_rowAccess', column, value, removeLabel: t('removeFilter', { column, value }), onRemove: () => list.onStateChange({ ...list.confirmedState, rowAccess: undefined }, 'filter') })
  }
  const views = definition.list?.views?.filter(view => readableWhere(view.where, model, entity, caps) && (!view.rowAccess || definition.rowInvitations && caps.resources?.['invitations.read'] === true)) ?? []

  const sortable = sortableFields(model, entity, caps)
  const error = list.result.error as { status?: number; code?: string } | null
  const Page = contextList ? EmbeddedListCard : ResourcePage
  if (error?.status === 403) return <Page title={title ?? t('forbidden')}><p>{t('resourceForbidden', { resource: t(`entity_${entity}`).toLocaleLowerCase(i18n.language) })}</p></Page>
  const accessAllowed = definition.rowInvitations && canReadApplicationAccess(caps) && (definition.list?.rowAccess === undefined || !!definition.list.rowAccess && !!definition.list.rowAccess.placement)
  const panelAccess = accessAllowed && definition.list?.rowAccess !== false && definition.list?.rowAccess?.placement === 'panel'
  const accessInput = (value: ReadQuery['rowAccess'], onChange: (value: ReadQuery['rowAccess']) => void) => <label className="grid min-w-0 max-w-full gap-2 text-sm">{t('rowAccessFilter')}<select aria-label={t('rowAccessFilter')} className="rounded-md border bg-background p-2" value={value ?? ''} onChange={event => onChange((event.target.value || undefined) as ReadQuery['rowAccess'])}><option value="">{t('rowAccessAll')}</option>{(['no_account', 'invited', 'expired', 'signed_in'] as const).map(state => <option key={state} value={state}>{t(`rowAccess_${state}`)}</option>)}</select></label>
  const search = listSearchableFields(model, entity, caps, contextList && list.state.presentation !== 'calendar' ? 'embedded' : list.state.presentation).length > 0 && <DataTableSearch value={list.state.search} onChange={search => list.onStateChange({ ...list.state, search }, 'search')} label={t('search')} clearLabel={t('clearSearch')} onPendingChange={setSearchPending} description={definition.list?.search && list.offsetPaging ? t('searchConfiguredFields', { fields: listSearchableFields(model, entity, caps, contextList && list.state.presentation !== 'calendar' ? 'embedded' : list.state.presentation).map(field => t(`field_${field}`)).join(', ') }) : t('searchAllColumns')} />
  const access = accessAllowed && !panelAccess && accessInput(list.state.rowAccess, rowAccess => list.onStateChange({ ...list.confirmedState, rowAccess }, 'filter'))
  const savedViews = !contextList && savedViewsScope && savedViewsScope.instance === model.instance && savedViewsScope.orgId === orgId && <SavedViewsControls scope={savedViewsScope} entity={entity} state={list.state} current={savedFingerprint(searchFromState(list.confirmedState))} initial={savedFingerprint(restoreSavedView({}, model, entity, caps).search)} fingerprint={search => savedFingerprint(restoreSavedView(search, model, entity, caps).search)} onApply={list.applySavedView} />
  const tabs = views.length > 0 && <ListViewTabs label={t('listViews')} views={[...(!views.some(view => view.id === 'all') ? [{ id: 'all', label: 'viewAll' }] : []), ...views].map(view => ({ id: view.id, label: t(view.label), count: list.offsetPaging ? list.data?.viewTotals?.[view.id] : undefined }))} value={list.state.view ?? 'all'} onChange={view => list.onStateChange({ ...list.state, view }, 'view')} />
  const immediateFilters = list.filters.filter(filter => filter.placement === 'toolbar').map(descriptor => <ToolbarFilter key={descriptor.field} model={model} caps={caps} orgId={orgId} entity={entity} descriptor={descriptor} request={request} predicate={list.state.userFilters.find(filter => filter.field === descriptor.field)?.predicate} onChange={predicate => setFilter(descriptor.field, predicate)} />)
  const hasPanel = panelAccess || list.filters.some(filter => filter.placement === 'panel')
  const panel = <FilterPanel model={model} caps={caps} orgId={orgId} entity={entity} request={request} descriptors={list.filters} filters={list.state.userFilters} confirmedFilters={list.confirmedState.userFilters} rowAccess={list.state.rowAccess} accessInput={panelAccess ? accessInput : undefined} onChange={(userFilters, rowAccess) => list.onStateChange({ ...list.state, userFilters, rowAccess }, 'filter')} {...(list.offsetPaging ? { open: filterOpen, onOpenChange: setFilterOpen } : {})} />
  const activeChips = <DataTableActiveFilters filters={chips} label={t('activeFilters')} clearLabel={t('clearAllFilters')} onClear={() => list.onStateChange({ ...list.state, userFilters: [], rowAccess: undefined }, 'filter')} />
  const presentation = availableCalendar(model, entity, caps) && <div role="group" aria-label={t('listPresentation')} className="flex flex-wrap gap-2 py-2">{(['table', 'calendar'] as const).map(presentation => <PrimitiveButton key={presentation} variant={list.state.presentation === presentation ? 'secondary' : 'ghost'} aria-pressed={list.state.presentation === presentation} onClick={() => list.onStateChange({ ...list.state, presentation }, 'view')}>{t(`${presentation}View`)}</PrimitiveButton>)}</div>
  const tableColumns = [
      ...listFields.map((field, index) => ({ id: field, align: listColumnAlignment(model, entity, field), label: field === 'id' || field === primary ? t(`field_${field}`) : t(`listField_${field}`, { defaultValue: t(`field_${field}`) }), sortable: sortable.includes(field), filter: !list.offsetPaging && list.filters.some(filter => filter.field === field) ? <HeaderFilter model={model} caps={caps} orgId={orgId} entity={entity} descriptor={list.filters.find(filter => filter.field === field)!} request={request} predicate={list.state.userFilters.find(filter => filter.field === field)?.predicate} onChange={predicate => setFilter(field, predicate)} /> : undefined, cell: (row: Record<string, any>) => <GeneratedListCell model={model} entity={entity} caps={caps} row={row} column={definition.list?.columns?.find(column => column.field === field) ?? { field }} orgId={orgId} primary={index === 0} signed={signedValue} /> })),
      ...((definition.accountLink || definition.rowInvitations) && (definition.list?.rowAccess === undefined || !!definition.list.rowAccess && definition.list.rowAccess.column) && write && canReadApplicationAccess(caps) ? [{ id: '_access', keepOnNarrow: true, wrap: true, label: t('rowAccess'), cell: (row: Record<string, any>) => <GeneratedRowInvitation model={model} caps={caps} orgId={orgId} entity={entity} request={request} write={write} onDenied={onDenied} row={row} disabled={list.stale || list.result.isFetching || searchPending} /> }] : []),
      ...(rowActions && hasRowActions(model, entity, caps) ? [{ id: '_actions', label: t('actions'), cell: (row: Record<string, any>) => <>{rowActions!(row, list.stale || list.result.isFetching || searchPending)}</> }] : []),
    ]
  const columnConfig = new Map((definition.list?.columns ?? []).map(column => [column.field, column]))
  const shown = (id: string) => visibility[id] ?? (columnConfig.get(id)?.defaultVisible !== false)
  // The first column is the record link and stays; hiding only drops presentation, never a selected field, filter, sort or count.
  const displayable = list.offsetPaging ? tableColumns.filter(column => column.id !== primary && column.id !== '_actions') : []
  // Reconcile the session preference with currently available columns; primary and Actions stay anchored.
  const ordered = [...new Set([...columnOrder, ...displayable.map(column => column.id)])].flatMap(id => displayable.find(column => column.id === id) ?? [])
  const moveColumn = (id: string, direction: -1 | 1) => {
    const visible = ordered.filter(column => shown(column.id))
    const index = visible.findIndex(column => column.id === id), target = visible[index + direction]
    if (index < 0 || !target) return
    const order = ordered.map(column => column.id), from = order.indexOf(id), to = order.indexOf(target.id)
    order[from] = target.id; order[to] = id
    setColumnOrder(order)
  }
  const columns = list.offsetPaging ? [...tableColumns.filter(column => column.id === primary), ...ordered.filter(column => shown(column.id)), ...tableColumns.filter(column => column.id === '_actions')] : tableColumns
  const content = list.state.presentation === 'calendar' ? <>
      <EntityCalendar model={model} entity={entity} caps={caps} orgId={orgId} state={list.state} data={list.data} pending={list.result.isFetching} error={error ? t(queryCodes.includes(error.code as any) ? `query_${error.code}` : 'requestFailed') : undefined} onChange={state => list.onStateChange(state, 'view')} onCreate={calendarCreate} onPage={list.onPage} previous={list.page > 0} />
    </> : <div className="caption-bottom"><DataTable fixedDensity={tableColumns.some(column => column.id === '_access')} listV2={list.offsetPaging} hideFooter={list.offsetPaging} scrollOnNarrow={list.offsetPaging} compact={compactPreference ?? definition.list?.compact} mobileCards={definition.list?.mobileCards} rows={rows} columns={columns} state={list.state} onStateChange={list.onStateChange} page={list.page} range={list.range} onPage={list.onPage} nextCursor={error ? null : list.data?.next_cursor} isFetching={list.result.isFetching} onRetry={() => { void list.result.refetch() }} error={error ? new Error(t(queryCodes.includes(error.code as any) ? `query_${error.code}` : 'requestFailed')) : null}
      label={t(`entity_${entity}`)} labels={{ error: t('requestFailed'), errorDescription: t('listRequestFailedDescription'), retry: t('listRetry'), search: t('search'), clearSearch: t('clearSearch'), noResults: list.result.isPending ? t('loading') : t('noResults'), emptyDescription: t(list.state.search || chips.length ? 'listEmptyFilteredDescription' : 'listEmptyViewDescription'), scrollRegion: t('listScrollRegion'), scrollHint: t('listScrollHint'), previous: t('previousPage'), next: t('nextPage'), previousText: t('paginationPrevious'), nextText: t('paginationNext'), pageSizeOption: size => t('paginationSize', { count: size }), pageSize: t('rowsPerPage'), sort: column => t('sortColumn', { column }), sortAndFilter: t('sortAndFilter'), sortStates: { asc: t('sortAscending'), desc: t('sortDescending'), none: t('sortNone') }, range: (start, end) => t('listRange', { start: new Intl.NumberFormat(i18n.language).format(start), end: new Intl.NumberFormat(i18n.language).format(end) }) }}
      staleLabel={list.stale ? t('listRowsStale') : undefined}
      clearFilters={t('clearSearchFilters')} onClearFilters={list.state.search || chips.length ? () => list.onStateChange({ ...list.state, search: '', userFilters: [], rowAccess: undefined }, 'filter') : undefined}
      searchAvailable={false} pendingSearch={searchPending}
      searchDescription={t('searchAllColumns')}
      onRowClick={row => { void navigate({ to: '/o/$orgId/e/$entity/$id', params: { orgId, entity, id: String(row.id) } }) }} /></div>
  return <Page count={contextList && list.result.isSuccess ? `${rows.length}${list.data?.next_cursor ? '+' : ''}` : undefined} title={title ?? t('pageTitle', { defaultValue: t(`entity_${entity}`), fallbackLng: false })} actionLabel={primaryAction?.label} onAction={primaryAction?.onAction} actions={<>{!list.offsetPaging && <>{search}{access}</>}{actions?.()}</>}>
    {listSearchableFields(model, entity, caps, contextList && list.state.presentation !== 'calendar' ? 'embedded' : list.state.presentation).join() === 'id' && <p className="text-sm text-muted-foreground">{t('searchById')}</p>}
    {list.notice && <p role="status" className="my-2 text-sm">{t(list.notice)}</p>}
    {error?.code === 'query_too_expensive' && list.undo && <PrimitiveButton variant="outline" onClick={list.undo}>{t('undoLastChange')}</PrimitiveButton>}
    {list.offsetPaging ? <ListPageComposition tabs={tabs} toolbar={<>
      {search && <div className="list-v2-search">{search}</div>}{(immediateFilters.length > 0 || access || hasPanel) && <div className="list-v2-lookup-panel">{immediateFilters}{access}{hasPanel && <PrimitiveButton variant="outline" title={t('sortAndFilter')} aria-expanded={filterOpen} onClick={() => setFilterOpen(value => !value)}>{t('sortAndFilter')}</PrimitiveButton>}</div>}
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{savedViews}{displayable.length > 0 && list.state.presentation !== 'calendar' && <DisplayMenu columns={ordered.map(column => ({ id: column.id, label: column.label, visible: shown(column.id) }))} compact={compactPreference ?? !!definition.list?.compact} labels={{ trigger: t('listDisplay'), heading: t('listDisplayHeading'), hint: t('listDisplayHint'), compact: t('listDisplayCompact'), reset: t('listDisplayReset'), moveUp: column => t('listDisplayMoveUp', { column }), moveDown: column => t('listDisplayMoveDown', { column }) }} onMove={moveColumn} onToggle={(id, visible) => setVisibility(old => ({ ...old, [id]: visible }))} onCompact={setCompactPreference} onReset={() => { setVisibility({}); setColumnOrder([]); setCompactPreference(undefined) }} />}{presentation}</div>
    </>} panel={filterOpen && hasPanel ? panel : undefined} chips={activeChips} footer={<ListPageFooter total={list.data?.total} page={list.page} limit={list.document.limit} pageSize={list.state.limit} maxOffset={model.limits.maxOffset ?? 10_000} busy={list.result.isFetching || searchPending} onPage={list.onPage} onPageSize={limit => list.onStateChange({ ...list.state, limit }, 'limit')} labels={{ loading: t('loading'), previous: t('previousPage'), next: t('nextPage'), pageSize: t('rowsPerPage'), pageSizeOption: size => t('paginationSize', { count: size }), range: (start, end, total) => t('listRangeTotal', { start: new Intl.NumberFormat(i18n.language).format(start), end: new Intl.NumberFormat(i18n.language).format(end), total: new Intl.NumberFormat(i18n.language).format(total) }) }} />}>{content}</ListPageComposition> : <>{savedViews}{tabs}{presentation}{immediateFilters}{panel}{activeChips}{content}</>}

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
    return spec.type === 'enum' && row[field] != null ? t(`value_${row[field]}`) : formatValue(row[field], spec, i18n.language, t('yes'), t('no'), t('nullValue'), model.timeZone)
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
  const configured = { ...model, entities: { ...model.entities, [list.entity]: { ...target, list: { ...target.list, ...(list.columns ? { columns: list.columns.map(field => target.list?.columns?.find(column => column.field === field) ?? { field }) } : {}), compact: true, mobileCards: target.list?.mobileCards ?? true } } } }
  return <GeneratedListPage key={`${model.instance}/${orgId}/${entity}/${id}/${name}/${caps.revision}`} model={configured} caps={caps} orgId={orgId} entity={list.entity} request={request} contextList={{ entity, id, list: name }} title={t(list.label, { defaultValue: list.label })} actions={() => list.create && create?.(list.entity, { [list.bind.field]: id })} />
}
function EmbeddedListCard({ title, actions, children, count }: { title: string; actions?: ReactNode; children?: ReactNode; count?: string; actionLabel?: string; onAction?: () => void }) {
  return <Card className="c2-relations min-w-0" data-context-list=""><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><h2>{title}</h2>{count !== undefined && <Badge variant="secondary">{count}</Badge>}</CardTitle><div className="flex flex-wrap items-center gap-2">{actions}</div></CardHeader><CardContent className="min-w-0">{children}</CardContent></Card>
}
