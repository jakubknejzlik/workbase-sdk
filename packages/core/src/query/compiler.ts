import { DisplayPartsExpression, needsDisplayParts, partsAlias } from './display-parts'
import { expressionInfo, readableComputed, rebindExpression, type ExpressionInfo } from './expressions'
import { ApiError } from '../errors'
import { Q, Fn, Cond, Condition, toSQLWithBindings, type ISQLFlavor, type SelectQuery, type ISequelizable } from '@jakub.knejzlik/ts-query'
import { renderPredicate, type KernelRegistry } from '../kernel/registry'
import { expandPolicyFilter, PolicyExpansionLimit } from '../kernel/predicate'
import type { TableFilter, PredicateRelation } from '../kernel/plugin'
import type { Scope } from '../types'
import { quote } from '../migrations/schema'
import { QueryError } from './errors'
import { enumLabel, valueLabel } from './search'
import { fieldType } from './schema'
import { labelPath, readableLabel, labelAlias, sortAlias, expressionColumns, expressionPath, readableDisplay } from './labels'
import { QUERY_LIMITS as L, type QueryCost } from './limits'
import type { Filter, Order, QueryInput, Scalar, Selection } from './schema'

export interface Statement { sql: string; bindings: unknown[] }
const col = (alias: string, field: string) => `${alias}.${field}`
const value = (v: unknown) => Q.value((typeof v === 'boolean' ? Number(v) : v) as Scalar)
const truth = (yes: boolean) => Cond.equal(Q.raw('1'), Q.raw(yes ? '1' : '0'))
/** Trusted structured predicates render in the library's binding context, never as raw question marks. */
class ScopedCondition extends Condition {
  constructor(private filter: TableFilter, private alias: string, private relation?: (node: PredicateRelation, parent: string, negated: boolean, flavor: ISQLFlavor) => string) { super() }
  toSQL(flavor: ISQLFlavor) {
    return this.filter.kind === 'where'
      ? renderPredicate(this.filter.predicate, this.alias, v => value(v).toSQL(flavor), this.relation ? (node, parent, negated) => this.relation!(node, parent, negated, flavor) : undefined).sql
      : this.filter.kind === 'all' ? '1=1' : '0=1'
  }
}
class ContainsCondition extends Condition {
  constructor(private column: string, private text: string, private insensitive = false) { super() }
  toSQL(flavor: ISQLFlavor) {
    const column = flavor.escapeColumn(this.column)
    if (!this.insensitive) return `instr(${column}, ${value(this.text).toSQL(flavor)}) > 0`
    // SQLite lower() folds ASCII. Fold the searched Unicode letters explicitly as
    // bound replacements too, so Czech names match either casing on D1.
    let folded = `lower(CAST(${column} AS TEXT))`
    for (const letter of new Set(this.text.toLowerCase())) {
      const upper = letter.toUpperCase()
      if (upper !== letter && /[^\x00-\x7f]/.test(upper)) folded = `replace(${folded}, ${value(upper).toSQL(flavor)}, ${value(letter).toSQL(flavor)})`
    }
    return `instr(${folded}, ${value(this.text.toLowerCase()).toSQL(flavor)}) > 0`
  }
}
/** D1 binds JS numbers as REAL; preserve that storage type and leave JSON text untouched. NULL is handled by the caller. */
class InCondition extends Condition {
  constructor(private column: string, private values: Scalar[]) { super() }
  toSQL(flavor: ISQLFlavor) {
    return `${flavor.escapeColumn(this.column)} IN (SELECT CASE WHEN type IN ('integer', 'real') THEN CAST(value AS REAL) ELSE value END FROM json_each(${value(JSON.stringify(this.values.map(v => typeof v === 'boolean' ? Number(v) : v))).toSQL(flavor)}))`
  }
}
/** The library assigns numbered placeholders; compact equal typed parameters afterwards.
 * Values never enter SQL text. Reusing a search term across columns costs one binding,
 * including when policy scopes repeat the same constants in visibility probes.
 */
function compactBindings(statement: Statement): Statement {
  const bindings: unknown[] = []; const indices = new Map<unknown, number>()
  // Trusted label literals can contain text such as '?1'; only rewrite placeholders
  // outside SQLite string/identifier quotes.
  const sql = statement.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\?(\d+)/g, (token, index: string | undefined) => {
    if (!index) return token
    const operand = statement.bindings[Number(index) - 1]
    if (!indices.has(operand)) { bindings.push(operand); indices.set(operand, bindings.length) }
    return `?${indices.get(operand)}`
  })
  return { sql, bindings }
}
// YEAR/MONTH are numeric in schema validation and cursor keys. SQLite strftime is text.
const numberedSQLite: ISQLFlavor = Object.assign(Object.create(Q.flavors.sqlite), {
  parameterPlaceholder: (index: number) => `?${index}`,
  escapeFunction(this: ISQLFlavor, ...args: Parameters<ISQLFlavor['escapeFunction']>) {
    const sql = Q.flavors.sqlite.escapeFunction.apply(this, args)
    return ['YEAR', 'MONTH'].includes(args[0].name) ? `CAST(${sql} AS INTEGER)` : sql
  },
})
/** One visibility check per readable FK in the scoped source, shared by all uses. */
class ForeignKeyValue extends Condition {
  constructor(private column: string | ISequelizable, private visible: Condition) { super() }
  toSQL(flavor: ISQLFlavor) {
    return `CASE WHEN ${this.visible.toSQL(flavor)} THEN ${typeof this.column === 'string' ? flavor.escapeColumn(this.column) : this.column.toSQL(flavor)} ELSE NULL END`
  }
}
/** Rebind trusted expression column operands to scoped source/join aliases. */
class DisplayExpression extends Condition {
  constructor(private expression: ISequelizable, private columns: Map<string, string | Condition>, private visible: Condition[]) { super() }
  toSQL(flavor: ISQLFlavor) {
    const qualified = Object.assign(Object.create(flavor), {
      // Fixed schema constants must match expression-index SQL. Request and policy
      // values still render with the original binding flavor, including FK probes.
      escapeValue: Q.flavors.sqlite.escapeValue.bind(Q.flavors.sqlite),
      escapeRawValue: Q.flavors.sqlite.escapeRawValue.bind(Q.flavors.sqlite),
      bindValue: undefined,
      escapeColumn: (column: string, legacy?: boolean) => {
        const mapped = this.columns.get(column)
        if (!mapped) return flavor.escapeColumn(column, legacy)
        return typeof mapped === 'string' ? flavor.escapeColumn(mapped) : mapped.toSQL(flavor)
      },
    })
    const sql = this.expression.toSQL(qualified)
    return this.visible.length ? `CASE WHEN ${Cond.and(this.visible).toSQL(flavor)} THEN ${sql} ELSE NULL END` : sql
  }
}
/** Validated config ASTs use the same scoped source transformation as every read. */
class ComputedExpression extends Condition {
  constructor(private info: ExpressionInfo, private columns: Map<string, string | Condition>, private visible: Condition[], private source: (entity: string) => SelectQuery) { super() }
  toSQL(flavor: ISQLFlavor) {
    const rendered = rebindExpression(this.info.ast, this.columns).toSQL(flavor, { transformTable: this.source })
    const sql = this.info.scalarQuery ? `(${rendered})` : rendered
    return this.visible.length ? `CASE WHEN ${Cond.and(this.visible).toSQL(flavor)} THEN ${sql} ELSE NULL END` : sql
  }
}
export function queryOrder(node: Selection): Order[] {
  const order = node.orderBy ?? []
  return order.some(o => o.field === 'id') ? order : [...order, { field: 'id', dir: 'asc' }]
}
export function selectedFields(kernel: KernelRegistry, scope: Scope, entity: string, node: Selection) {
  return node.select ?? kernel.fieldMask(entity, scope)
}
/** Includes and cursors may need unprojected columns; all are still checked against fieldMask. */
export function executionFields(kernel: KernelRegistry, scope: Scope, entity: string, node: Selection, extra: string[] = []) {
  return [...new Set([...selectedFields(kernel, scope, entity, node), ...queryOrder(node).filter(o => !o.label).map(o => o.field), ...extra,
    ...Object.keys(node.include ?? {}).map(relation => {
      const r = kernel.config.entities[entity].relations[relation]
      return r.many ? 'id' : r.field
    })])]
}
/** Internal AST only. All caller input has passed validateQuery before reaching this module. */
function filterCondition(kernel: KernelRegistry, entity: string, alias: string, filter: Filter, nextAlias: () => string, positive = true): Condition {
  const conditions: Condition[] = []
  for (const [key, v] of Object.entries(filter)) {
    if (key === 'and' || key === 'or') {
      const children = (v as Filter[]).map(child => filterCondition(kernel, entity, alias, child, nextAlias, positive))
      conditions.push(key === 'and' ? Cond.and(children) : Cond.or(children)); continue
    }
    if (key === 'not') { conditions.push(Cond.not(filterCondition(kernel, entity, alias, v as Filter, nextAlias, false))); continue }
    if (Object.hasOwn(kernel.config.entities[entity].relations, key)) {
      const r = kernel.config.entities[entity].relations[key]; const childAlias = nextAlias()
      const quantifier = r.many ? Object.keys(v as object)[0] : undefined
      const sub = Q.select().from(r.entity, childAlias).field(col(childAlias, 'id'))
        .where(Cond.columnEqual(col(childAlias, r.many ? r.field : 'id'), col(alias, r.many ? 'id' : r.field)))
        .where(filterCondition(kernel, r.entity, childAlias, (quantifier ? (v as Record<string, Filter>)[quantifier] : v) as Filter, nextAlias))
      conditions.push(quantifier === 'none' ? Cond.notExists(sub) : Cond.exists(sub)); continue
    }
    const column = col(alias, key)
    for (const [op, operand] of Object.entries(v as object)) {
      // Keep the masked predicate as the visibility residual. A redundant raw seek
      // is safe only in positive contexts: FALSE versus UNKNOWN matters under NOT.
      if (positive && kernel.config.entities[entity].fields[key]?.type === 'ref' && !kernel.config.entities[entity].fields[key].computed) {
        if (op === 'eq' && operand !== null) conditions.push(Cond.equal(col(alias, `__raw_${key}`), value(operand)))
        if (op === 'in' && (operand as Scalar[]).length && !(operand as Scalar[]).includes(null)) conditions.push(new InCondition(col(alias, `__raw_${key}`), operand as Scalar[]))
      }
      const methods = { eq: Cond.equal, ne: Cond.notEqual, lt: Cond.lessThan, lte: Cond.lessThanOrEqual, gt: Cond.greaterThan, gte: Cond.greaterThanOrEqual }
      if (op === 'isNull') conditions.push(operand ? Cond.isNull(column) : Cond.isNotNull(column))
      else if ((op === 'eq' || op === 'ne') && operand === null) conditions.push(op === 'eq' ? Cond.isNull(column) : Cond.isNotNull(column))
      else if (op === 'in') {
        const list = operand as Scalar[]; const nonnull = list.filter(x => x !== null)
        conditions.push(list.length ? Cond.or([...(nonnull.length ? [new InCondition(column, nonnull)] : []), ...(list.includes(null) ? [Cond.isNull(column)] : [])]) : truth(false))
      } else if (op === 'contains') conditions.push(new ContainsCondition(column, operand as string))
      else conditions.push(methods[op as keyof typeof methods](column, value(operand)))
    }
  }
  return conditions.length ? Cond.and(conditions) : truth(true)
}
function hasRequiredForeignKeySeek(kernel: KernelRegistry, entity: string, filter: Filter): boolean {
  return Object.entries(filter).some(([field, operand]) => {
    if (field === 'and') return (operand as Filter[]).some(child => hasRequiredForeignKeySeek(kernel, entity, child))
    if (kernel.config.entities[entity].fields[field]?.type !== 'ref' || kernel.config.entities[entity].fields[field].computed) return false
    const operators = operand as Record<string, unknown>
    return (Object.hasOwn(operators, 'eq') && operators.eq !== null)
      || (Array.isArray(operators.in) && operators.in.length > 0 && !operators.in.includes(null))
  })
}
/** SQLite NULLs sort first ascending, last descending. Build a lexicographic seek with the same semantics. */
function seek(alias: string, order: Order[], keys: Scalar[], preferForeignKeySeek = false) {
  return Cond.or(order.map((o, index) => {
    const column = preferForeignKeySeek ? Q.raw(`+${quote(alias)}.${quote(o.field)}`) : col(alias, o.field)
    const key = keys[index]
    const after = key === null ? o.dir === 'asc' ? Cond.isNotNull(column) : truth(false)
      : o.dir === 'asc' ? Cond.greaterThan(column, value(key)) : Cond.or([Cond.lessThan(column, value(key)), Cond.isNull(column)])
    return Cond.and([...order.slice(0, index).map((prev, i) => keys[i] === null ? Cond.isNull(col(alias, prev.field)) : Cond.equal(col(alias, prev.field), value(keys[i]))), after])
  }))
}
export function assertStatement(statement: Statement, cost?: QueryCost) {
  if (statement.bindings.length > L.bindings || statement.sql.length > L.sqlLength) throw new QueryError('query_too_expensive', [], cost)
  return statement
}
export function renderStatement(kernel: KernelRegistry, scope: Scope, ast: SelectQuery, cost?: QueryCost, requiredDisplays?: Set<string>): Statement {
  let references = 0
  function scopedTable(entity: string, extra?: (alias: string) => Condition, maskForeignKeys = true, displayRequired = requiredDisplays?.has(entity) ?? true, computedDemand?: Set<string>): SelectQuery {
    if (!maskForeignKeys) computedDemand = new Set()
    if (!Object.hasOwn(kernel.config.entities, entity)) throw new QueryError('query_invalid')
    // Bounds policy recursion too, before a future policy compiler can introduce cycles.
    if (++references > L.tableReferences) throw new QueryError('query_too_expensive', [], cost)
    const alias = `scope_row_${references}`
    let query = Q.select().from(entity, alias)
    const fields = kernel.fieldMask(entity, scope)
    const definition = kernel.config.entities[entity]
    const foreignKeys = new Map<string, Condition>()
    function foreignKeyVisible(field: string) {
      let visible = foreignKeys.get(field)
      if (!visible) {
        const target = definition.fields[field].entity!
        visible = kernel.fieldMask(target, scope).includes('id') && kernel.can(scope, target, 'read')
          ? Cond.exists(scopedTable(target, child => Cond.columnEqual(col(child, 'id'), col(alias, field)), false))
          : truth(false)
        foreignKeys.set(field, visible)
      }
      return visible
    }
    const computed = new Map<string, Condition>()
    const computedOperands = new Map<string, Condition>()
    const computedVisibility = new Map<string, Condition>()
    const emptyComputedReferences = new Map<string, Condition>()
    const computing = new Set<string>()
    const presentation = new Map<string, Condition>()
    function computedValue(field: string): Condition {
      const previous = computed.get(field); if (previous) return previous
      if (computing.has(field)) throw new QueryError('query_invalid')
      if (!readableComputed(kernel, scope, entity, field)) return new DisplayExpression(Q.value(null), new Map(), [])
      computing.add(field)
      const info = expressionInfo(kernel.config, entity, field, definition.fields[field].computed!)
      const columns = new Map<string, string | Condition>(); const visible: Condition[] = []; const nested = new Map<string, ISequelizable>()
      const paths = new Map<string, string>()
      const demands = new Map<string, Set<string>>()
      for (const dependency of info.dependencies) {
        if (dependency.qualifier && dependency.qualifier !== 'self') continue
        const key = dependency.hops.map(hop => `/${hop.field}`).join('')
        const demand = demands.get(key) ?? new Set<string>(); demand.add(dependency.field); demands.set(key, demand)
      }
      for (const dependency of info.dependencies) {
        // Subquery aliases resolve against their own scoped projections. `self`
        // always denotes this row; no physical source name is ever rebound.
        if (dependency.qualifier && dependency.qualifier !== 'self') continue
        let parent = alias; let key = ''
        for (const hop of dependency.hops) {
          key += `/${hop.field}`
          let target = paths.get(key)
          if (!target) {
            const table = scopedTable(hop.target, undefined, true, true, demands.get(key) ?? new Set())
            target = `computed_join_${references}_${paths.size}`; paths.set(key, target)
            const operand = parent === alias && definition.fields[hop.field]?.computed ? computedValue(hop.field) : col(parent, hop.field)
            query = query.leftJoin(Q.table(table, target), Cond.equal(col(target, 'id'), typeof operand === 'string' ? Q.expr(operand) : operand))
            visible.push(Cond.isNotNull(col(target, 'id')))
          }
          parent = target
        }
        if (parent === alias && definition.fields[dependency.field]?.computed) {
          computedValue(dependency.field)
          columns.set(dependency.column, computedOperands.get(dependency.field)!)
          visible.push(computedVisibility.get(dependency.field) ?? truth(false))
        } else if (parent === alias && definition.fields[dependency.field]?.type === 'ref') {
          const allowed = foreignKeyVisible(dependency.field)
          columns.set(dependency.column, col(alias, dependency.field))
          visible.push(Cond.or([Cond.isNull(col(alias, dependency.field)), allowed]))
        } else {
          columns.set(dependency.column, col(parent, dependency.field))
          if (kernel.config.entities[dependency.entity].label && dependency.field === kernel.config.entities[dependency.entity].displayField) visible.push(Cond.equal(col(parent, '__display_visible'), Q.raw('1')))
          if (kernel.config.entities[dependency.entity].fields[dependency.field]?.computed) visible.push(Cond.equal(col(parent, `__computed_visible_${dependency.field}`), Q.raw('1')))
          else if (kernel.config.entities[dependency.entity].fields[dependency.field]?.type === 'ref') visible.push(Cond.or([
            Cond.isNull(col(parent, `__raw_${dependency.field}`)), Cond.isNotNull(col(parent, dependency.field)),
          ]))
        }
      }
      const source = (target: string) => scopedTable(target, undefined, true, true, info.tables.get(target) ?? new Set())
      if (needsDisplayParts(kernel.config, entity, field)) {
        for (const dep of info.dependencies) if ((!dep.qualifier || dep.qualifier === 'self') && needsDisplayParts(kernel.config, dep.entity, dep.field)) {
          if (!dep.hops.length) { computedValue(dep.field); nested.set(dep.column, presentation.get(dep.field)!) }
          else {
            const parent = paths.get(dep.hops.map(hop => `/${hop.field}`).join(''))!
            nested.set(dep.column, Q.expr(col(parent, partsAlias(dep.field))))
          }
        }
        presentation.set(field, new DisplayPartsExpression(info.parts!, columns, nested, source))
      }
      // Keep the operand and its availability separate internally. Reusing an
      // already-masked operand loses NULL provenance and recursively duplicates
      // visibility probes for every layer of a composed expression.
      const operand = new ComputedExpression(info, columns, [], source)
      computedOperands.set(field, operand)
      let result: Condition = new ComputedExpression(info, columns, visible, source)
      const dependenciesVisible = visible.length ? Cond.and(visible) : truth(true)
      computedVisibility.set(field, dependenciesVisible)
      if (definition.fields[field].type === 'ref') {
        // A masked NULL is not absence. Carry both states through computed
        // dependencies, including nullable scalar intermediates and joined rows.
        const empty = Cond.and([dependenciesVisible, Cond.isNull(operand)])
        emptyComputedReferences.set(field, empty)
        const allowed = Cond.exists(scopedTable(definition.fields[field].entity!, child => Cond.equal(col(child, 'id'), operand), false))
        computedVisibility.set(field, Cond.and([dependenciesVisible, Cond.or([Cond.isNull(operand), allowed])]))
        result = new ForeignKeyValue(operand, Cond.and([dependenciesVisible, allowed]))
      }
      computed.set(field, result); computing.delete(field); return result
    }
    const joins = new Map<string, string>()
    let label: Condition | ReturnType<typeof Q.raw> = Q.raw('NULL')
    const labelVisibility: Condition[] = []
    if (maskForeignKeys && displayRequired && (!computedDemand || computedDemand.has(definition.displayField!)) && definition.label && readableDisplay(kernel, scope, entity)) {
      const columns = new Map<string, string | Condition>()
      // A joined source computes its own label only when this expression consumes
      // it. Passing through an account to its customer does not need account.label.
      const displayJoins = new Set(expressionColumns(definition.label).flatMap(column => {
        const path = expressionPath(kernel.config, entity, column)
        return path.field === kernel.config.entities[path.entity].displayField ? [`/${path.hops.map(hop => hop.field).join('/')}`] : []
      }))
      for (const column of expressionColumns(definition.label)) {
        const path = expressionPath(kernel.config, entity, column)
        let parent = alias; let key = ''
        for (const hop of path.hops) {
          key += `/${hop.field}`
          let target = joins.get(key)
          if (!target) {
            const table = scopedTable(hop.target, undefined, true, displayJoins.has(key))
            target = `expression_join_${references}_${joins.size}`; joins.set(key, target)
            const operand = parent === alias && definition.fields[hop.field]?.computed ? computedValue(hop.field) : col(parent, hop.field)
            query = query.leftJoin(Q.table(table, target), Cond.equal(col(target, 'id'), typeof operand === 'string' ? Q.expr(operand) : operand))
          }
          parent = target
        }
        if (parent === alias && definition.fields[path.field]?.computed) {
          const operand = computedValue(path.field)
          columns.set(column, operand)
          labelVisibility.push(Cond.isNotNull(operand))
        } else if (parent === alias && definition.fields[path.field]?.type === 'ref') {
          const visible = foreignKeyVisible(path.field)
          columns.set(column, new ForeignKeyValue(col(alias, path.field), visible))
          labelVisibility.push(Cond.or([Cond.isNull(col(alias, path.field)), visible]))
        } else {
          columns.set(column, col(parent, path.field))
          const target = kernel.config.entities[path.entity]
          // A raw NULL is ordinary absence; a non-null raw FK masked to NULL is
          // denied. Reuse its masked projection rather than add another EXISTS.
          if (target.fields[path.field]?.computed) labelVisibility.push(Cond.equal(col(parent, `__computed_visible_${path.field}`), Q.raw('1')))
          else if (target.fields[path.field]?.type === 'ref') labelVisibility.push(Cond.or([
            Cond.isNull(col(parent, `__raw_${path.field}`)), Cond.isNotNull(col(parent, path.field)),
          ]))
          if (target.label && path.field === target.displayField) labelVisibility.push(Cond.equal(col(parent, '__display_visible'), Q.raw('1')))
        }
      }
      labelVisibility.push(...[...joins.values()].map(target => Cond.isNotNull(col(target, 'id'))))
      label = new DisplayExpression(definition.label, columns, labelVisibility)
    }
    if (maskForeignKeys && displayRequired && definition.label) query = query.field(readableDisplay(kernel, scope, entity) ? labelVisibility.length ? Cond.and(labelVisibility) : Q.raw('1') : Q.raw('0'), '__display_visible')
    for (const field of fields) {
      const definition = kernel.config.entities[entity].fields[field]
      if (definition?.computed) {
        const projected = !computedDemand || computedDemand.has(field) ? computedValue(field) : Q.raw('NULL')
        query = query.field(projected, field)
        if (maskForeignKeys) {
          query = query.field(computedVisibility.get(field) ?? truth(false), `__computed_visible_${field}`)
          if (definition.type === 'ref') query = query.field(emptyComputedReferences.get(field) ?? truth(false), `__empty_${field}`)
        }
        if (maskForeignKeys && (!computedDemand || computedDemand.has(field)) && needsDisplayParts(kernel.config, entity, field)) {
          query = query.field(presentation.get(field) ?? Q.raw('NULL'), partsAlias(field))
        }
      } else if (kernel.config.entities[entity].label && field === kernel.config.entities[entity].displayField) {
        query = query.field(label, field)
      } else if (maskForeignKeys && definition?.type === 'ref') {
        // Target identity must itself be readable. Visibility probes expose no target
        // columns and use the same scoped predicate/correlation as policy relations.
        const visible = foreignKeyVisible(field)
        query = query.field(new ForeignKeyValue(col(alias, field), visible), field)
          .field(col(alias, field), `__raw_${field}`)
      } else query = query.field(col(alias, field))
    }
    if (!fields.length) query = query.field(Q.raw('1'), '__policy_row')
    query = query.where(new ScopedCondition(expandPolicyFilter(entity, child => kernel.tableFilter(child, scope), L.tableReferences), alias, relation))
    return extra ? query.where(extra(alias)) : query
  }
  function relation(node: PredicateRelation, parent: string, negated: boolean, flavor: ISQLFlavor): string {
    if (++references > L.tableReferences) throw new QueryError('query_too_expensive', [], cost)
    const child = `scope_row_${references}`; const visible = `${child}_visible`
    // The shared expansion already scoped this source and moved all authority to
    // the root. Expose only the stored correlation key; no field projection or
    // policy expansion may add authority back beneath this quantifier.
    const explicit = new ScopedCondition({ kind: 'where', predicate: node.predicate }, child, relation).toSQL(flavor)
    return `${negated ? 'NOT ' : ''}EXISTS(SELECT 1 FROM (SELECT ${quote(child)}.${quote(node.field)} AS ${quote('policy_key')} FROM ${quote(node.entity)} AS ${quote(child)} WHERE ${explicit}) AS ${quote(visible)} WHERE ${quote(visible)}.${quote('policy_key')}=${quote(parent)}.${quote(node.parentField)})`
  }
  try {
    return assertStatement(compactBindings(toSQLWithBindings(ast, numberedSQLite, { transformTable: entity => scopedTable(entity) })), cost)
  } catch (error) {
    if (error instanceof PolicyExpansionLimit) throw new QueryError('query_too_expensive', [], cost)
    if (error instanceof ApiError) throw error
    throw new QueryError('query_invalid')
  }
}

/** Expression demand follows all user-visible uses, including unprojected filters.
 * The table transform is entity-based; multiple occurrences share this conservative
 * union. Expression-internal joins carry their own narrower dependency demand.
 */
function requiredDisplayEntities(kernel: KernelRegistry, scope: Scope, entity: string, node: Selection) {
  const required = new Set<string>()
  const add = (source: string, fields: string[]) => {
    if (fields.includes(kernel.config.entities[source].displayField!)) required.add(source)
  }
  const filter = (source: string, where: Filter) => {
    for (const [field, operand] of Object.entries(where)) {
      if (field === 'and' || field === 'or') { (operand as Filter[]).forEach(child => filter(source, child)); continue }
      if (field === 'not') { filter(source, operand as Filter); continue }
      const relation = kernel.config.entities[source].relations[field]
      if (relation) filter(relation.entity, relation.many ? Object.values(operand as Record<string, Filter>)[0] : operand as Filter)
      else add(source, [field])
    }
  }
  add(entity, executionFields(kernel, scope, entity, node))
  if (node.where) filter(entity, node.where)
  return { required, add }
}

export function buildSelect(kernel: KernelRegistry, scope: Scope, entity: string, node: Selection, extras: string[] = []) {
  let aliases = 0
  let ast = Q.select().from(entity, 'row')
  for (const field of executionFields(kernel, scope, entity, node, [...extras, ...((node as QueryInput).search?.fields ?? []).filter(key => !labelPath(kernel.config, entity, key))])) ast = ast.field(col('row', field))
  const display = kernel.config.entities[entity].displayField
  if (display && selectedFields(kernel, scope, entity, node).includes(display) && needsDisplayParts(kernel.config, entity, display)) ast = ast.field(col('row', partsAlias(display)))
  if (node.where) ast = ast.where(filterCondition(kernel, entity, 'row', node.where, () => `rel_${++aliases}`))
  return ast
}
/** Server-configured aggregate over the same masked, policy-scoped source as lists.
 * No LIMIT on the input: a stat covers all authorized matching rows in one statement.
 */
export function compileAggregate(kernel: KernelRegistry, scope: Scope, query: QueryInput,
  aggregate: { fn: 'count' } | { fn: 'sum'; field: string }, cost?: QueryCost) {
  const source = buildSelect(kernel, scope, query.entity, query)
  const expression = aggregate.fn === 'count' ? Fn.count('aggregate_row.id') : Fn.sum(col('aggregate_row', aggregate.field))
  const ast = Q.select().from(source, 'aggregate_row').field(expression, 'value').field(Fn.count('aggregate_row.id'), '__count')
  return renderStatement(kernel, scope, ast, cost, requiredDisplayEntities(kernel, scope, query.entity, query).required)
}
/** All values come from scoped joined tables; a missing/denied target has one safe marker. */
class LabelObject extends Condition {
  constructor(private entity: string, private alias: string, private display?: string, private parts = false) { super() }
  toSQL(flavor: ISQLFlavor) {
    const id = flavor.escapeColumn(col(this.alias, 'id'))
    const display = this.display ? value(this.display).toSQL(flavor) : 'NULL'
    const row = this.display ? `json_object('id', ${id}, ${display}, ${flavor.escapeColumn(col(this.alias, this.display))}${this.parts ? `, '__display', json(${flavor.escapeColumn(col(this.alias, partsAlias(this.display)))})` : ''})` : `json_object('id', ${id})`
    return `CASE WHEN ${id} IS NULL THEN json_object('status', 'unavailable') ELSE json_object('status', 'ok', 'entity', ${value(this.entity).toSQL(flavor)}, 'display', ${display}, 'row', ${row}) END`
  }
}
/** Only an absent FK on an authorized source row is empty. A failed join is not. */
class NullableLabel extends Condition {
  constructor(private empty: Condition, private label: ISequelizable) { super() }
  toSQL(flavor: ISQLFlavor) {
    return `CASE WHEN ${this.empty.toSQL(flavor)} THEN json_object('status', 'empty') ELSE ${this.label.toSQL(flavor)} END`
  }
}
export const orderField = (order: Order) => order.label ? sortAlias(order.field) : order.field
export function compileRoot(kernel: KernelRegistry, scope: Scope, query: QueryInput, keys?: Scalar[], cost?: QueryCost) {
  let source = buildSelect(kernel, scope, query.entity, query)
  const { required, add } = requiredDisplayEntities(kernel, scope, query.entity, query)
  add(query.entity, query.search?.fields ?? [])
  const labelKeys = [...new Set([...(query.labels ?? []), ...Object.keys(query.labelWhere ?? {}), ...(query.search?.fields ?? []).filter(key => labelPath(kernel.config, query.entity, key)), ...(query.orderBy ?? []).filter(o => o.label).map(o => o.field)])]
  const joins = new Map<string, string>()
  const emptyReference = (parent: string, hop: { source: string; field: string }) =>
    kernel.config.entities[hop.source].fields[hop.field].computed
      ? readableComputed(kernel, scope, hop.source, hop.field) ? Cond.equal(col(parent, `__empty_${hop.field}`), Q.raw('1')) : truth(false)
      : Cond.isNull(col(parent, `__raw_${hop.field}`))
  for (const key of labelKeys) {
    const plan = readableLabel(kernel, scope, query.entity, key)
    const first = labelPath(kernel.config, query.entity, key)!.hops[0]
    const empty: Condition[] = [emptyReference('row', first)]
    let expression: Condition | ReturnType<typeof Q.raw> = Q.raw("json_object('status', 'unavailable')")
    if (plan) {
      if (plan.display) add(plan.entity, [plan.display])
      let parent = 'row'; let path = ''
      for (const hop of plan.hops) {
        if (parent !== 'row') empty.push(Cond.and([Cond.isNotNull(col(parent, 'id')), emptyReference(parent, hop)]))
        path += `/${hop.field}`
        let alias = joins.get(path)
        if (!alias) {
          alias = `label_join_${joins.size}`; joins.set(path, alias)
          source = source.leftJoin(Q.table(hop.target, alias), Cond.columnEqual(col(alias, 'id'), col(parent, hop.field)))
        }
        parent = alias
      }
      expression = new LabelObject(plan.entity, parent, plan.display, !!plan.display && needsDisplayParts(kernel.config, plan.entity, plan.display))
    }
    source = source.field(new NullableLabel(Cond.or(empty), expression), labelAlias(key))
  }
  // Compute the key once from the authorized label, then seek/order/limit over it.
  let labeled = Q.select().from(source, 'labels').field('labels.*')
  for (const key of labelKeys) {
    const display = readableLabel(kernel, scope, query.entity, key)?.display
    labeled = labeled.field(display ? Q.raw(`json_extract(${quote('labels')}."${labelAlias(key)}", '$.row.${display}')`) : Q.raw('NULL'), sortAlias(key))
  }
  let ast = labelKeys.length ? Q.select().from(labeled, 'row').field('row.*') : source
  const order = queryOrder(query).map(o => ({ ...o, field: orderField(o) }))
  function searchCondition(key: string, text: string, locale: 'en' | 'cs' = 'en'): Condition {
    const path = labelPath(kernel.config, query.entity, key)
    const plan = path ? readableLabel(kernel, scope, query.entity, key) : undefined
    if (path && !plan?.display) return truth(false)
    const entity = plan?.entity ?? query.entity; const field = plan?.display ?? key
    const column = col('row', path ? sortAlias(key) : key)
    const spec = kernel.config.entities[entity].fields[field]
    const needle = text.toLocaleLowerCase(locale)
    if (spec?.type === 'enum') {
      const matches = (spec.values ?? []).filter(code => enumLabel(kernel.config, entity, code, locale).toLocaleLowerCase(locale).includes(needle))
      return matches.length ? new InCondition(column, matches) : truth(false)
    }
    if (fieldType(kernel.config, entity, field) === 'bool') {
      const matches = [
        ...(valueLabel(kernel.config, entity, 'yes', locale).toLocaleLowerCase(locale).includes(needle) ? [Cond.equal(column, value(true))] : []),
        ...(valueLabel(kernel.config, entity, 'no', locale).toLocaleLowerCase(locale).includes(needle) ? [Cond.equal(column, value(false))] : []),
      ]
      return matches.length ? Cond.or(matches) : truth(false)
    }
    return new ContainsCondition(column, text, true)
  }
  for (const [key, predicate] of Object.entries(query.labelWhere ?? {})) ast = ast.where(searchCondition(key, predicate.contains, predicate.locale))
  if (query.search) ast = ast.where(Cond.or(query.search.fields.map(key => searchCondition(key, query.search!.text, query.search!.locale))))
  // With ID-only ordering and LIMIT, SQLite otherwise prefers scanning the tenant's
  // (org,id) index even over a selective raw FK predicate. Unary + preserves the
  // value/order but leaves index selection to the FK filter; sort its candidates.
  // Apply it to cursor comparisons too, so later pages keep the selective index.
  // Do not steer disjunctions, negative filters or other indexed ordering shapes.
  const preferForeignKeySeek = order.length === 1 && order[0].field === 'id' && !!query.where && hasRequiredForeignKeySeek(kernel, query.entity, query.where)
  if (keys) ast = ast.where(seek('row', order, keys, preferForeignKeySeek))
  for (const o of order) ast = ast.orderBy(preferForeignKeySeek ? Q.raw(`+${quote('row')}.${quote(o.field)}`) : col('row', o.field), o.dir.toUpperCase() as 'ASC' | 'DESC')
  ast = ast.limit(query.limit + 1)
  return { ast, ...renderStatement(kernel, scope, ast, cost, required) }
}
/** One statement per relation per level; all parent identities share one JSON binding. */
export function compileInclude(kernel: KernelRegistry, scope: Scope, entity: string, node: Selection, parentField: string, ids: Scalar[], cost?: QueryCost) {
  let child = buildSelect(kernel, scope, entity, node, [parentField])
  child = child.where(ids.length ? new InCondition(col('row', parentField), ids) : truth(false))
  if (kernel.config.entities[entity].fields[parentField]?.type === 'ref' && !kernel.config.entities[entity].fields[parentField].computed && ids.length && !ids.includes(null)) child = child.where(new InCondition(col('row', `__raw_${parentField}`), ids))
  const fields = executionFields(kernel, scope, entity, node, [parentField])
  const sort = queryOrder(node).map(o => `${quote('row')}.${quote(o.field)} ${o.dir.toUpperCase()}`).join(', ')
  child = child.field(Q.raw(`ROW_NUMBER() OVER (PARTITION BY ${quote('row')}.${quote(parentField)} ORDER BY ${sort})`), '__row_number')
  let outer = Q.select().from(child, 'ranked')
  for (const field of fields) outer = outer.field(col('ranked', field))
  const display = kernel.config.entities[entity].displayField
  if (display && selectedFields(kernel, scope, entity, node).includes(display) && needsDisplayParts(kernel.config, entity, display)) outer = outer.field(col('ranked', partsAlias(display)))
  outer = outer.where(Cond.lessThanOrEqual('ranked.__row_number', value(node.limit ?? L.children)))
    .orderBy('ranked.__row_number').orderBy(col('ranked', parentField))
  return renderStatement(kernel, scope, outer, cost, requiredDisplayEntities(kernel, scope, entity, node).required)
}
