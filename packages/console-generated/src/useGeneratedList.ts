import { availableCalendar } from './calendar-model'
import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { createDataTableQueryKey, type DataTableState } from '@workbasehq/ui'
import { searchFromState, stateFromSearch, toQueryDocument, validateListSearch, type ListSearch, type ListState } from './list-model'
import { selectedReferenceOptions, selectedReferenceRow } from './use-selected-references'
import type { Capabilities, Model, ReadQuery, Result } from './read'
type ListNotice = 'listStateDropped' | 'listCursorRestarted'
interface PageHistory { scope: string; signature: string; cursors: string[]; notice?: ListNotice }
interface PreviousState { scope: string; search: ListSearch; cursors: string[] }
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
  const { state, dropped } = stateFromSearch(search, model, entity, caps)
  const canonicalFiltersChanged = JSON.stringify(search.filters ?? []) !== JSON.stringify(state.userFilters)
  const scope = JSON.stringify([model.instance, orgId, entity, caps, contextList])
  const signature = JSON.stringify(searchFromState(state))
  const history = contextList ? local.history : (location.state as { generatedList?: PageHistory }).generatedList
  const cursors = history?.scope === scope && history.signature === signature && Array.isArray(history.cursors) && history.cursors.every(cursor => typeof cursor === 'string') ? history.cursors : []
  state.cursor = cursors.at(-1)
  const notice = dropped ? 'listStateDropped' : history?.scope === scope && history.signature === signature && ['listStateDropped', 'listCursorRestarted'].includes(history.notice ?? '') ? history.notice : null
  const previous = useRef<PreviousState | undefined>(undefined)
  const lastGood = useRef<{ scope: string; data: Result; page: number; limit: number } | undefined>(undefined)
  const go = (next: ListSearch, nextCursors: string[], replace = false, notice?: ListNotice) => contextList ? Promise.resolve(setLocal({ search: next, history: { scope, signature: JSON.stringify(searchFromState(stateFromSearch(next, model, entity, caps).state)), cursors: nextCursors, notice } })) : currentRoute ? navigate({ to: '.', search: next as any, replace, resetScroll: false,
    state: old => ({ ...old, generatedList: { scope, signature: JSON.stringify(searchFromState(stateFromSearch(next, model, entity, caps).state)), cursors: nextCursors, notice } }) }) : Promise.resolve()
  useEffect(() => {
    if (!contextList && (dropped || canonicalFiltersChanged || Object.hasOwn(location.search, 'cursor'))) void go(searchFromState(state), [], true, dropped ? 'listStateDropped' : Object.hasOwn(location.search, 'cursor') ? 'listCursorRestarted' : undefined)
  }, [currentRoute, dropped, canonicalFiltersChanged, signature, location.searchStr])
  const { i18n } = useTranslation()
  const document = toQueryDocument(state, model, entity, caps, i18n.language?.startsWith('cs') ? 'cs' : 'en')
  if (contextList) {
    document.contextList = contextList
    const definition = model.entities[entity]
    const calendar = state.presentation === 'calendar' ? availableCalendar(model, entity, caps) : undefined
    const columns = [...(definition.displayField ? [definition.displayField] : []), ...(definition.list?.columns ?? definition.listColumns ?? definition.columns), ...(calendar ? [calendar.startField, calendar.endField, calendar.titleField ?? definition.displayField, ...(calendar.titleFields ?? []), calendar.secondaryField].filter((field): field is string => !!field) : [])]
    // Embedded cards fetch rendered values and identities; search/filter/sort stay server operands.
    document.select = [...new Set(['id', ...columns.flatMap(field => [definition.list?.relatedColumns?.[field]?.via ?? field, ...definition.fields[field]?.ui?.signedBy ? [definition.fields[field].ui!.signedBy!.field] : []])])].filter(field => caps.entities[entity]?.readable.includes(field))
  }
  const key = createDataTableQueryKey(scope, 'list', document)
  const result = useQuery({ queryKey: key, queryFn: () => request(document), retry: false, enabled: currentRoute,
    placeholderData: (data, query) => state.presentation !== 'calendar' && query?.queryKey[1] === scope ? keepPreviousData(data) : undefined })
  if (result.isSuccess && !result.isPlaceholderData) lastGood.current = { scope, data: result.data, page: cursors.length, limit: state.limit }
  const failure = result.error as { code?: string; details?: { path?: (string | number)[] } } | null
  useEffect(() => {
    if (state.cursor && failure?.code === 'query_invalid' && failure.details?.path?.includes('cursor')) {
      void go(searchFromState(state), [], true, 'listCursorRestarted')
    }
  }, [failure, state.cursor])
  const data = result.data ?? (state.presentation !== 'calendar' && failure?.code === 'query_too_expensive' && lastGood.current?.scope === scope ? lastGood.current.data : undefined)
  const onStateChange = (next: DataTableState & Partial<ListState>, change: 'search' | 'sort' | 'limit' | 'filter' | 'view') => {
    previous.current = { scope, search: searchFromState(state), cursors }
    void go(searchFromState({ ...state, ...next, cursor: undefined }), [], change === 'search')
  }
  const onPage = (direction: 'previous' | 'next') => {
    previous.current = { scope, search: searchFromState(state), cursors }
    if (direction === 'previous') void go(searchFromState(state), cursors.slice(0, -1))
    else if (data?.next_cursor) void go(searchFromState(state), [...cursors, data.next_cursor])
  }
  const undo = () => { const target = previous.current; if (target?.scope === scope) { previous.current = undefined; void go(target.search, target.cursors, true) } }
  return { stale: failure?.code === 'query_too_expensive' && !!data, state, document, result, data, notice, onStateChange, onPage, page: cursors.length, range: lastGood.current?.scope === scope ? { page: lastGood.current.page, limit: lastGood.current.limit } : { page: 0, limit: state.limit }, undo: previous.current?.scope === scope ? undo : undefined }
}
/** Detail and picker labels only. Lists receive their labels in the content response. */
export function useRelationLabels(model: Model, entity: string, caps: Capabilities, orgId: string, columns: string[], rows: Record<string, any>[], request: (query: ReadQuery) => Promise<Result>) {
  const client = useQueryClient()
  const fields = columns.flatMap(field => {
    const target = model.entities[entity].fields[field]?.entity
    return target && caps.entities[entity]?.readable.includes(field) && caps.entities[target]?.operations.includes('read') && caps.entities[target].readable.includes('id') ? [{ field, target, display: caps.entities[target]?.displayField ?? model.entities[target].displayField }] : []
  })
  const plans = [...new Set(fields.map(field => field.target))].flatMap(target => {
    const targetFields = fields.filter(field => field.target === target)
    const ids = [...new Set(targetFields.flatMap(({ field }) => rows.filter(row => !['empty', 'unavailable'].includes(row.__labels?.[field]?.status)).map(row => row[field]).filter((id): id is string => typeof id === 'string' && !!id)))]
    const known = targetFields.flatMap(({ field }) => rows.flatMap(row => { const value = selectedReferenceRow(model, entity, field, row); return value ? [value] : [] }))
    return ids.map(id => ({ target, id, known }))
  })
  const results = useQueries({ queries: plans.map(plan => selectedReferenceOptions(client, model, caps, orgId, plan.target, plan.id, plan.known, request)) })
  return (field: string, id: unknown) => {
    const definition = fields.find(plan => plan.field === field)
    const index = plans.findIndex(plan => plan.target === definition?.target && plan.id === id)
    const row = index < 0 || results[index].error ? undefined : plans[index].known.find(row => row.id === id) ?? results[index].data
    return row && definition ? { entity: definition.target, row, display: definition.display && caps.entities[definition.target].readable.includes(definition.display) ? definition.display : undefined } : undefined
  }
}
