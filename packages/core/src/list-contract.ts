import type { RowAccessState } from './query/row-access-state'

/** Serializable list presentation contract. Authoring shorthand is normalized once. */
export type ListFilterKind = 'text' | 'enum' | 'relation' | 'number' | 'date' | 'boolean'
export type ListOperator = 'eq' | 'in' | 'contains' | 'gte' | 'gt' | 'lte' | 'lt' | 'isNull'
export type ListPlacement = 'toolbar' | 'panel'
export type ListTone = 'neutral' | 'positive' | 'warning' | 'negative'
export type ListCell = { kind: 'text' } | { kind: 'identifier'; copy?: boolean } | { kind: 'badge'; tones?: Record<string, ListTone> } | { kind: 'date' | 'datetime' | 'number' }
export interface ListColumn { field: string; label?: string; secondary?: string; cell?: ListCell; defaultVisible?: boolean }
export interface ListFilter { kind: ListFilterKind; label?: string; placement: ListPlacement; operators: ListOperator[] }
export interface ListConfig {
  columns?: ListColumn[]
  relatedColumns?: Record<string, { via: string; field: string }>
  compact?: boolean; mobileCards?: boolean
  defaultSort?: { key: string; direction: 'asc' | 'desc' }
  pageSize?: 10 | 20 | 30 | 50 | 100
  search?: string[]
  filter?: Record<string, false | ListFilter>
  rowAccess?: false | { column?: boolean; placement?: ListPlacement; label?: string }
  views?: { id: string; label: string; where: Record<string, unknown>; rowAccess?: RowAccessState; default?: boolean }[]
  sort?: Record<string, false | { fields: string[] }>
}

/** Backwards-compatible authoring unions; only ListConfig is sent on the wire. */
export interface ListInput extends Omit<ListConfig, 'columns' | 'filter' | 'views' | 'search' | 'sort'> {
  columns?: readonly (string | ListColumn)[]
  filter?: Record<string, false | ListFilterKind | (Partial<Omit<ListFilter, 'operators'>> & { operators?: readonly ListOperator[] })>
  views?: readonly (Omit<NonNullable<ListConfig['views']>[number], 'where'> & { where?: Record<string, unknown> })[]
  search?: readonly string[]
  sort?: Record<string, false | { fields: readonly string[] }>
}
