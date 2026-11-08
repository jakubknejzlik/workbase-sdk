import { z } from 'zod'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { KernelRegistry } from '@workbasehq/core/kernel/registry'
import type { Scope } from '../../../core/src/types'
import { ApiError } from '../../../core/src/errors'
import { querySchema, validateQuery, type QueryInput } from '@workbasehq/core/query/schema'
import { compileAggregate, compileRoot } from '@workbasehq/core/query/compiler'
import { projectRootRow, type Row } from '../../../core/src/query/executor'
import { detailSectionsSchema } from '../../../core/src/detail-layout'
import { QUERY_LIMITS } from '../../../core/src/query/limits'
import type { ConsolePage, ConsolePageResult, ConsoleWidget } from './contract'

const common = { id: z.string().min(1), label: z.string().min(1) }
const widgetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('stat'), query: z.strictObject({ entity: z.string(), where: z.record(z.string(), z.unknown()).optional() }),
    aggregate: z.discriminatedUnion('fn', [z.strictObject({ fn: z.literal('count') }), z.strictObject({ fn: z.literal('sum'), field: z.string() })]) }),
  z.strictObject({ ...common, kind: z.literal('table'), query: z.unknown(), columns: z.array(z.string()).min(1) }),
  z.strictObject({ ...common, kind: z.literal('list'), query: z.unknown(), field: z.string() }),
])
/** Stats validate all consumed fields/filters through the list query grammar too. */
export function widgetQuery(widget: ConsoleWidget): QueryInput {
  return widget.kind === 'stat' ? { ...widget.query, select: widget.aggregate.fn === 'sum' ? ['id', widget.aggregate.field].filter((key, i, keys) => keys.indexOf(key) === i) : ['id'], limit: 1 } : widget.query
}
export function validateWidgets(config: InstanceConfig, page: ConsolePage) {
  if (!page.widgets) {
    if (page.sections) throw new Error(`Console rows require widgets: ${page.id}`)
    return
  }
  z.array(widgetSchema).min(1).max(QUERY_LIMITS.statements).parse(page.widgets)
  const ids = new Set<string>()
  for (const widget of page.widgets) {
    if (ids.has(widget.id)) throw new Error(`Duplicate console widget: ${page.id}.${widget.id}`)
    ids.add(widget.id)
    const query = widgetQuery(widget)
    if (!Object.hasOwn(config.entities, query.entity)) throw new Error(`Unknown console widget entity: ${query.entity}`)
    querySchema(config, query.entity).parse(query)
    // Dashboard widgets are flat single statements, never include trees or cursors.
    if (query.include || query.cursor) throw new Error(`Console widget must use one query: ${widget.id}`)
    if (widget.kind !== 'stat') {
      const fields = widget.kind === 'table' ? widget.columns : [widget.field]
      if (!query.select || fields.some(field => !query.select!.includes(field) && !query.labels?.includes(field))) throw new Error(`Unknown or unselected console widget field: ${widget.id}`)
      if (new Set(fields).size !== fields.length) throw new Error(`Duplicate console widget column: ${widget.id}`)
    } else if (widget.aggregate.fn === 'sum' && !['int', 'float'].includes(config.entities[query.entity].fields[widget.aggregate.field]?.type)) {
      throw new Error(`Console sum requires a numeric field: ${widget.id}`)
    }
  }
  const seen = new Set<string>()
  for (const section of detailSectionsSchema.parse(page.sections ?? [])) {
    if (!('row' in section)) throw new Error(`Console widget sections require a row: ${page.id}`)
    for (const key of section.row) {
      if (!ids.has(key) || seen.has(key)) throw new Error(`Unknown or duplicate console widget row key: ${page.id}.${key}`)
      seen.add(key)
    }
  }
}
/** Omit denied widgets, including unreadable filter/order/aggregate inputs. */
export function visibleWidgets(kernel: KernelRegistry, scope: Scope, widgets: readonly ConsoleWidget[]) {
  return widgets.filter(widget => {
    if (!kernel.can(scope, widget.query.entity, 'read')) return false
    try { validateQuery(kernel, scope, widgetQuery(widget)); return true }
    catch (error) { if (error instanceof ApiError && error.status === 403) return false; throw error }
  })
}
export async function executeWidgets(kernel: KernelRegistry, scope: Scope, db: D1Database, page: ConsolePage): Promise<ConsolePageResult> {
  const jobs = visibleWidgets(kernel, scope, page.widgets ?? []).map(widget => {
    const { query, cost } = validateQuery(kernel, scope, widgetQuery(widget))
    const statement = widget.kind === 'stat' ? compileAggregate(kernel, scope, query, widget.aggregate, cost) : compileRoot(kernel, scope, query, undefined, cost)
    return { widget, query, statement }
  })
  // Compile and authorize everything before executing; exactly one statement per widget.
  const results = jobs.length ? await db.batch<Row>(jobs.map(({ statement }) => db.prepare(statement.sql).bind(...statement.bindings))) : []
  const widgets: ConsolePageResult['widgets'] = []
  jobs.forEach(({ widget, query }, index) => {
    const rows = results[index].results
    const policy = kernel.tableFilter(query.entity, scope)
    const empty = widget.kind === 'stat' ? rows[0]?.__count === 0 : !rows.length
    if ('deny' in policy && policy.deny === 'forbidden' && empty) return
    const common = { id: widget.id, label: widget.label }
    if (widget.kind === 'stat') widgets.push({ ...common, kind: 'stat', value: rows[0]?.value ?? null })
    else {
      const data = rows.slice(0, query.limit).map(row => projectRootRow(kernel, scope, query, row))
      widgets.push(widget.kind === 'table' ? { ...common, kind: 'table', columns: widget.columns, data } : { ...common, kind: 'list', field: widget.field, data })
    }
  })
  const allowed = new Set(widgets.map(widget => widget.id))
  const sections = page.sections?.map(section => ({ row: section.row.filter(id => allowed.has(id)) })).filter(section => section.row.length)
  return { id: page.id, label: page.label, sections, widgets }
}
