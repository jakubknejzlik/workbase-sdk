import { filterDescriptors } from './filter-kinds'
import { availableCalendar } from './calendar-model'
import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { createDataTableQueryKey, type DataTableState } from '@workbasehq/ui'
import { searchFromState, stateFromSearch, toQueryDocument, validateListSearch, type ListSearch, type ListState } from './list-model'
import { restoreSavedView } from './saved-views'
import { selectedReferenceOptions } from './use-selected-references'
import { useReferenceAuthority } from './reference-authority'
import { useReconciledFilters } from './use-reconciled-filters'
import type { Capabilities, Model, ReadQuery, Result } from './read'
type ListNotice = 'listStateDropped' | 'listCursorRestarted'
interface PageHistory { scope: string; signature: string; cursors: string[]; page?: number; notice?: ListNotice }
interface PreviousState { scope: string; search: ListSearch; cursors: string[]; page?: number }
/** Root state lives in Router; embedded state lives in its card. Query isolates rows by scope. */
export function useGeneratedList({ model, caps, orgId, entity, request, contextList }: { contextList?: ReadQuery['contextList']; model: Model; caps: Capabilities; orgId: string; entity: string; request: (input: ReadQuery) => Promise<Result> }) {
  const location = useLocation(); const navigate = useNavigate()
  // Router location can advance before the outgoing route's props unmount. Never
  // canonicalize the destination's saved view against that outgoing entity.
  const [local, setLocal] = useState<{ search: ListSearch; history?: PageHistory }>({ search: {} })
  const currentRoute = !!contextList || location.pathname.replace(/\/$/, '') === `/o/${encodeURIComponent(orgId)}/e/${encodeURIComponent(entity)}`
  // Read search and cursor state from one Router location snapshot. Separate match/search
  // subscriptions can briefly combine old search with new history state during navigation.
  const search = contextList ? local.search : validateListSearch(location.search as Record<string, unknown>)
  const filters = filterDescriptors(model, entity, caps)
  const restored = stateFromSearch(search, model, entity, caps, filters, !!contextList)
  const [restoreAttempt, setRestoreAttempt] = useState(0)
  const reconciled = useReconciledFilters(model, caps, orgId, entity, restored.state.userFilters, filters, request, currentRoute, restoreAttempt)
  const state = { ...restored.state, userFilters: reconciled.filters }
  const dropped = restored.dropped || reconciled.dropped
  const authority = useReferenceAuthority()
  const canonicalFiltersChanged = reconciled.ready && JSON.stringify(search.filters ?? []) !== JSON.stringify(state.userFilters)
  // Fresh authority observations isolate query data without discarding unchanged paging history.
  const scope = JSON.stringify([model.instance, model.revision, orgId, entity, caps, contextList, authority?.actor])
  const queryScope = JSON.stringify([scope, model.entities[entity], authority?.observedAt])
  const signature = JSON.stringify(searchFromState(state))
  const history = contextList ? local.history : (location.state as { generatedList?: PageHistory }).generatedList
  const cursors = !dropped && !canonicalFiltersChanged && history?.scope === scope && history.signature === signature && Array.isArray(history.cursors) && history.cursors.every(cursor => typeof cursor === 'string') ? history.cursors : []
  const offsetPaging = !contextList && state.presentation !== 'calendar'
  const page = offsetPaging && !dropped && !canonicalFiltersChanged && history?.scope === scope && history.signature === signature && Number.isSafeInteger(history.page) && history.page! >= 0 ? history.page! : offsetPaging ? 0 : cursors.length
  state.cursor = offsetPaging ? undefined : cursors.at(-1)
  if (offsetPaging) state.offset = page * Math.min(state.limit, model.limits.root)
  const notice = dropped ? 'listStateDropped' : history?.scope === scope && history.signature === signature && ['listStateDropped', 'listCursorRestarted'].includes(history.notice ?? '') ? history.notice : null
  const previous = useRef<PreviousState | undefined>(undefined)
  // Key whose response has settled; only a background refetch of that same key may keep its rows mounted.
  const settledKey = useRef<string | undefined>(undefined)
  const lastGood = useRef<{ scope: string; data: Result; page: number; limit: number } | undefined>(undefined)
  const go = (next: ListSearch, nextCursors: string[], replace = false, notice?: ListNotice, nextPage = 0) => contextList ? Promise.resolve(setLocal({ search: next, history: { scope, signature: JSON.stringify(searchFromState(stateFromSearch(next, model, entity, caps, undefined, !!contextList).state)), cursors: nextCursors, page: nextPage, notice } })) : currentRoute ? navigate({ to: '.', search: next as any, replace, resetScroll: false,
    state: old => ({ ...old, generatedList: { scope, signature: JSON.stringify(searchFromState(stateFromSearch(next, model, entity, caps, undefined, !!contextList).state)), cursors: nextCursors, page: nextPage, notice } }) }) : Promise.resolve()
  useEffect(() => {
    const legacyCursor = !contextList && Object.hasOwn(location.search, 'cursor')
    if (reconciled.ready && (dropped || canonicalFiltersChanged || legacyCursor)) void go(searchFromState(state), [], true, dropped ? 'listStateDropped' : legacyCursor ? 'listCursorRestarted' : undefined)
  }, [currentRoute, reconciled.ready, dropped, canonicalFiltersChanged, signature, location.searchStr])
  const { i18n } = useTranslation()
  const document = toQueryDocument(state, model, entity, caps, i18n.language?.startsWith('cs') ? 'cs' : 'en', filters, !!contextList)
  if (contextList) {
    document.contextList = contextList
    const definition = model.entities[entity]
    const calendar = state.presentation === 'calendar' ? availableCalendar(model, entity, caps) : undefined
    const columns = [...(definition.displayField ? [definition.displayField] : []), ...(definition.list?.columns?.map(column => column.field) ?? definition.listColumns ?? definition.columns), ...(calendar ? [calendar.startField, calendar.endField, calendar.titleField ?? definition.displayField, ...(calendar.titleFields ?? []), calendar.secondaryField].filter((field): field is string => !!field) : [])]
    // Embedded cards fetch rendered values and identities; search/filter/sort stay server operands.
    document.select = [...new Set(['id', ...columns.flatMap(field => [definition.list?.relatedColumns?.[field]?.via ?? field, ...definition.fields[field]?.ui?.signedBy ? [definition.fields[field].ui!.signedBy!.field] : []])])].filter(field => caps.entities[entity]?.readable.includes(field))
  }
  const key = createDataTableQueryKey(queryScope, 'list', document)
  const queryResult = useQuery({ queryKey: key, queryFn: () => request(document), retry: false, enabled: currentRoute && reconciled.ready,
    placeholderData: (data, query) => !offsetPaging && reconciled.ready && state.presentation !== 'calendar' && query?.queryKey[1] === queryScope ? keepPreviousData(data) : undefined })
  const reconciling = !reconciled.ready && !reconciled.error
  const result = { ...queryResult, error: reconciled.error ?? queryResult.error,
    isPending: reconciling || queryResult.isPending, isFetching: reconciling || queryResult.isFetching }
  if (reconciled.ready && result.isSuccess && !result.isPlaceholderData) lastGood.current = { scope: queryScope, data: result.data, page, limit: state.limit }
  const failure = result.error as { code?: string; details?: { path?: (string | number)[] } } | null
  useEffect(() => {
    if (state.cursor && failure?.code === 'query_invalid' && failure.details?.path?.includes('cursor')) {
      void go(searchFromState(state), [], true, 'listCursorRestarted')
    }
  }, [failure, state.cursor])
  const keyId = JSON.stringify(key)
  if (offsetPaging && reconciled.ready && result.isSuccess && !result.isFetching && !result.isPlaceholderData) settledKey.current = keyId
  // A cached response for a different key is stale until its own fetch settles; the same key stays mounted while refetching.
  const data = offsetPaging ? reconciled.ready && result.isSuccess && !result.isPlaceholderData && (!result.isFetching || settledKey.current === keyId) ? result.data : undefined : reconciled.ready ? result.data ?? (state.presentation !== 'calendar' && failure?.code === 'query_too_expensive' && lastGood.current?.scope === queryScope ? lastGood.current.data : undefined) : undefined
  const onStateChange = (next: DataTableState & Partial<ListState>, change: 'search' | 'sort' | 'limit' | 'filter' | 'view') => {
    previous.current = { scope, search: searchFromState(state), cursors, page }
    // A panel draft can outlive its authority; every submission needs fresh ID proof.
    if (change === 'filter') setRestoreAttempt(value => value + 1)
    void go(searchFromState({ ...state, ...next, ...(change !== 'filter' ? { userFilters: restored.state.userFilters } : {}), cursor: undefined }), [], change === 'search')
  }
  const onPage = (direction: 'previous' | 'next' | number) => {
    if (offsetPaging) {
      const target = typeof direction === 'number' ? direction : page + (direction === 'next' ? 1 : -1)
      const limit = Math.min(state.limit, model.limits.root)
      if (!data || !Number.isSafeInteger(data.total) || !Number.isSafeInteger(target) || target === page || target < 0 || target * limit > (model.limits.maxOffset ?? 10_000) || target > Math.max(0, Math.ceil(data.total! / limit) - 1)) return
      previous.current = { scope, search: searchFromState(state), cursors, page }
      void go(searchFromState(state), [], false, undefined, target)
      return
    }
    previous.current = { scope, search: searchFromState(state), cursors, page }
    if (direction === 'previous') void go(searchFromState(state), cursors.slice(0, -1))
    else if (data?.next_cursor) void go(searchFromState(state), [...cursors, data.next_cursor])
  }
  const undo = () => { const target = previous.current; if (target?.scope === scope) { previous.current = undefined; void go(target.search, target.cursors, true, undefined, target.page) } }
  const applySavedView = (search: unknown) => {
    setRestoreAttempt(value => value + 1)
    const restored = restoreSavedView(search, model, entity, caps)
    previous.current = undefined
    void go(restored.search, [], false, restored.dropped ? 'listStateDropped' : undefined)
  }
  return { confirmedState: restored.state, offsetPaging, filters, applySavedView, stale: !offsetPaging && failure?.code === 'query_too_expensive' && !!data, state, document, result, data, notice, onStateChange, onPage, page, range: lastGood.current?.scope === queryScope ? { page: lastGood.current.page, limit: lastGood.current.limit } : { page: 0, limit: state.limit }, undo: previous.current?.scope === scope ? undo : undefined }
}
/** Detail and picker labels only. Lists receive their labels in the content response. */
export function useRelationLabels(model: Model, entity: string, caps: Capabilities, orgId: string, columns: string[], rows: Record<string, any>[], request: (query: ReadQuery) => Promise<Result>) {
  const client = useQueryClient()
  const authority = useReferenceAuthority()
  const fields = columns.flatMap(field => {
    const target = model.entities[entity].fields[field]?.entity
    return target && caps.entities[entity]?.readable.includes(field) && caps.entities[target]?.operations.includes('read') && caps.entities[target].readable.includes('id') ? [{ field, target, display: caps.entities[target]?.displayField ?? model.entities[target].displayField }] : []
  })
  const plans = [...new Set(fields.map(field => field.target))].flatMap(target => {
    const targetFields = fields.filter(field => field.target === target)
    const ids = [...new Set(targetFields.flatMap(({ field }) => rows.filter(row => !['empty', 'unavailable'].includes(row.__labels?.[field]?.status)).map(row => row[field]).filter((id): id is string => typeof id === 'string' && !!id)))]
    return ids.map(id => ({ target, id }))
  })
  const results = useQueries({ queries: plans.map(plan => selectedReferenceOptions(client, model, caps, orgId, plan.target, plan.id, request, authority)) })
  return (field: string, id: unknown) => {
    const definition = fields.find(plan => plan.field === field)
    const index = plans.findIndex(plan => plan.target === definition?.target && plan.id === id)
    const row = index < 0 || results[index].error ? undefined : results[index].data
    return row && definition ? { entity: definition.target, row, display: definition.display && caps.entities[definition.target].readable.includes(definition.display) ? definition.display : undefined } : undefined
  }
}
