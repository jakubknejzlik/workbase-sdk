import { useEffect, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { pickerQuery } from './write'
import { visibleEntities, type Model, type Capabilities, type ReadQuery, type Result } from './read'

/** Choices always use the authorized list query, including declared lookup catalogs. */
export function usePickerSearch(model: Model, caps: Capabilities, orgId: string, target: string, request: (query: ReadQuery) => Promise<Result>, options: { where?: ReadQuery['where']; select?: string[] } = {}) {
  const { i18n } = useTranslation(); const locale = i18n.language?.startsWith('cs') ? 'cs' : 'en'
  const [focused, setFocused] = useState(false)
  const [search, setSearch] = useState(''); const [debounced, setDebounced] = useState('')
  useEffect(() => { const timer = setTimeout(() => setDebounced(search), 500); return () => clearTimeout(timer) }, [search])
  const allowed = visibleEntities(model, caps).includes(target)
  const settling = search !== debounced
  const result = useInfiniteQuery({ queryKey: ['picker', model.instance, orgId, caps, target, debounced, locale, options], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const query = pickerQuery(model, target, caps, { search: debounced, cursor: pageParam, locale })
      if (options.select) query.select = [...new Set([...query.select, ...options.select.filter(field => model.entities[target].fields[field] && caps.entities[target]?.readable.includes(field))])]
      if (options.where) query.where = query.where ? { and: [options.where, query.where] } : options.where
      return request(query)
    },
    getNextPageParam: page => page.next_cursor ?? undefined, enabled: allowed && focused && !settling, retry: false, refetchOnWindowFocus: false })
  return { allowed, search, setSearch: (text: string) => { setFocused(true); setSearch(text) }, result, loading: settling || result.isFetching,
    rows: allowed && !settling ? result.data?.pages.flatMap(page => page.data) ?? [] : [],
    focus: () => setFocused(true), close: () => { setFocused(false); setSearch(''); setDebounced('') },
    hasMore: !settling && result.hasNextPage,
    loadMore: () => { if (!settling && !result.isFetching && result.hasNextPage) void result.fetchNextPage() } }
}
