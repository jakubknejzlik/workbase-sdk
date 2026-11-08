import { needsDisplayParts, parseDisplayParts, partsAlias } from './display-parts'
import { ApiError } from '../errors'
import type { KernelRegistry } from '../kernel/registry'
import type { Scope } from '../types'
import { compileRoot, compileInclude, queryOrder, orderField, selectedFields, type Statement } from './compiler'
import { decodeCursor, encodeCursor, inputHash, queryHash } from './cursor'
import { QUERY_LIMITS as L, type QueryCost } from './limits'
import { labelAlias } from './labels'
import { QueryError, type QueryPath } from './errors'
import { validateQuery, type QueryInput, type Scalar, type Selection } from './schema'
export type Row = Record<string, any>
/** Shared projection for entity reads and server-configured dashboard queries. */
export function projectQueryRow(kernel: KernelRegistry, scope: Scope, entity: string, node: Selection, row: Row): Row {
  const result = Object.fromEntries(selectedFields(kernel, scope, entity, node).map(field => [field,
    kernel.config.entities[entity].fields[field]?.type === 'bool' && row[field] !== null ? Boolean(row[field]) : row[field]]))
  const display = kernel.config.entities[entity].displayField
  if (display && result[display] != null && needsDisplayParts(kernel.config, entity, display) && row[partsAlias(display)]) result.__display = parseDisplayParts(row[partsAlias(display)])
  return result
}
export function projectRootRow(kernel: KernelRegistry, scope: Scope, query: QueryInput, row: Row): Row {
  return { ...projectQueryRow(kernel, scope, query.entity, query, row), ...(query.labels ? {
    __labels: Object.fromEntries(query.labels.map(key => [key, projectLabel(row[labelAlias(key)])])),
  } : {}) }
}
function projectLabel(value: string | null) {
  if (!value) return null
  const label = JSON.parse(value)
  if (label.row?.__display) {
    if (label.row[label.display] == null) delete label.row.__display
    else label.row.__display = parseDisplayParts(label.row.__display)
  }
  return label
}
export interface QueryResult { data: Row[]; next_cursor: string | null }
export type { QueryLog } from './observability'
import { emptyQueryLog, recordQuery, type QueryLog } from './observability'
/** Count configured shape only after validation; never inspect policy trees or values. */
function shape(kernel: KernelRegistry, scope: Scope, query: QueryInput, cost: QueryCost) {
  let selectCount = 0; let includeCount = 0
  function visit(entity: string, node: Selection) {
    selectCount += (node.select ?? kernel.fieldMask(entity, scope)).length
    for (const [key, child] of Object.entries(node.include ?? {})) {
      includeCount++; visit(kernel.config.entities[entity].relations[key].entity, child)
    }
  }
  visit(query.entity, query)
  return { entity: query.entity, depth: cost.depth, relationCount: cost.relations, selectCount, includeCount }
}
export async function executeQuery(kernel: KernelRegistry, scope: Scope, db: D1Database, secret: string, input: unknown,
  options: { writeLog?: (log: QueryLog) => void; legacyErrors?: boolean } = {}): Promise<QueryResult> {
  const started = performance.now()
  let bindingCount = 0; let bindingHighWaterMark = 0; let resultRows = 0; let rowsRead: number | null = null
  let hash = await inputHash(input); let cost: QueryCost | undefined; let query: QueryInput | undefined; let statementCount = 0; let outcome = 'query_invalid'
  try {
    const validated = validateQuery(kernel, scope, input, options.legacyErrors)
    query = validated.query; cost = validated.cost; hash = await queryHash(kernel.config, scope, query)
    const keys = await decodeCursor(secret, hash, kernel.config, query)
    let totalRows = 0
    async function run(statements: Statement[]) {
      if (!statements.length) return []
      statementCount += statements.length
      if (statementCount > L.statements) throw new QueryError('query_too_expensive', [], cost)
      // The compiler owns all statements. Driver/library errors never cross the query boundary.
      for (const statement of statements) {
        bindingCount += statement.bindings.length; bindingHighWaterMark = Math.max(bindingHighWaterMark, statement.bindings.length)
      }
      try {
        const results = await db.batch<Row>(statements.map(statement => db.prepare(statement.sql).bind(...statement.bindings)))
        for (const result of results) if (typeof result.meta?.rows_read === 'number') rowsRead = (rowsRead ?? 0) + result.meta.rows_read
        return results.map(result => result.results)
      }
      catch { throw new QueryError('query_invalid') }
    }
    function assertDenial(entity: string, rows: Row[], path: QueryPath = []) {
      const filter = kernel.tableFilter(entity, scope)
      if ('deny' in filter && filter.deny === 'forbidden' && !rows.length) throw new QueryError('policy_violation', path)
    }
    const [root] = await run([compileRoot(kernel, scope, query, keys, cost)])
    assertDenial(query.entity, root)
    const more = root.length > query.limit; const rows = root.slice(0, query.limit); totalRows += rows.length
    const nextCursor = more ? await encodeCursor(secret, hash, kernel.config.revision, queryOrder(query).map(o => rows.at(-1)![orderField(o)] ?? null)) : null
    const data = rows.map(row => projectRootRow(kernel, scope, query!, row))
    type Job = { entity: string; node: Selection; raw: Row[]; out: Row[]; path: QueryPath }
    let level: Job[] = [{ entity: query.entity, node: query, raw: rows, out: data, path: [] }]
    while (level.some(job => Object.keys(job.node.include ?? {}).length)) {
      if (level.reduce((sum, job) => sum + job.raw.length, 0) > L.parents) throw new QueryError('query_too_expensive', ['include'], cost)
      const next: Job[] = []; let levelRows = 0
      const pending = []
      for (const job of level) for (const [key, node] of Object.entries(job.node.include ?? {})) {
        const path = [...job.path, 'include', key]
        const relation = kernel.config.entities[job.entity].relations[key]
        const parentField = relation.many ? relation.field : 'id'
        const ids = [...new Set(job.raw.map(row => row[relation.many ? 'id' : relation.field]).filter(id => id !== null && id !== undefined))] as Scalar[]
        // Parent identities share one JSON binding, independent of parent count.
        // compileInclude checks the complete policy/client/window statement budget.
        pending.push({ job, key, node, path, relation, parentField,
          statement: ids.length ? compileInclude(kernel, scope, relation.entity, node, parentField, ids, cost) : null })
      }
      // Siblings depend only on their shared parent level. Compile the whole level
      // before executing it, preserving statement/binding limits and one D1 trip.
      const results = await run(pending.flatMap(item => item.statement ? [item.statement] : []))
      let resultIndex = 0
      for (const { job, key, node, path, relation, parentField, statement } of pending) {
        const found = statement ? results[resultIndex++] : []
        levelRows += found.length; totalRows += found.length
        if (levelRows > L.levelRows || totalRows > L.rows) throw new QueryError('query_too_expensive', ['include', key], cost)
        assertDenial(relation.entity, found, path)
        const projected = found.map(row => projectQueryRow(kernel, scope, relation.entity, node, row))
        const groups = new Map<unknown, Row[]>()
        found.forEach((row, i) => { const group = groups.get(row[parentField]) ?? []; group.push(projected[i]); groups.set(row[parentField], group) })
        job.raw.forEach((row, i) => { const group = groups.get(row[relation.many ? 'id' : relation.field]) ?? []; job.out[i][key] = relation.many ? group : group[0] ?? null })
        next.push({ entity: relation.entity, node, raw: found, out: projected, path })
      }
      level = next
    }
    resultRows = data.length
    outcome = 'ok'; return { data, next_cursor: nextCursor }
  } catch (error) {
    if (error instanceof QueryError && error.cost) cost = error.cost
    outcome = error instanceof ApiError ? error.code : 'query_invalid'
    if (error instanceof ApiError || options.legacyErrors) throw error
    throw new QueryError('query_invalid')
  } finally {
    const log: QueryLog = { ...emptyQueryLog(scope, hash),
      shape: query ? shape(kernel, scope, query, cost!) : emptyQueryLog(scope, hash).shape,
      estimatedCost: cost ?? null, statementCount, bindingCount, bindingHighWaterMark, rowsRead,
      resultRows, durationMs: performance.now() - started, errorCode: outcome === 'ok' ? null : outcome }
    if (options.writeLog) options.writeLog(log)
    else recordQuery(db, log)
  }
}
