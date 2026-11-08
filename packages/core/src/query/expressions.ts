import { readableDisplay } from './labels'
import { Q, SelectQuery, type ISequelizable } from '@jakub.knejzlik/ts-query'
import type { InstanceConfig } from '../config'
import type { KernelRegistry } from '../kernel/registry'
import type { Scope } from '../types'

export const DISPLAY_VALUE = 'computed_display'
export const isExpression = (value: string) => !/^[a-z][a-z0-9_]*$/.test(value)
type Config = Pick<InstanceConfig, 'entities'>
type Kind = 'string' | 'number' | 'bool' | 'datetime' | 'null'
export interface Dependency { column: string; entity: string; field: string; hops: { source: string; field: string; target: string }[]; qualifier?: string; sourcePath?: string }
export type DisplayParts = { wire: string; type: Kind | 'date' } | { concat: DisplayParts[] } | { condition: string; yes: DisplayParts; no: DisplayParts } | { coalesce: { wire: string; parts: DisplayParts }[] }
interface ValueInfo { type: Kind; dateOnly: boolean; calendarDate?: boolean; textDependencies?: Dependency[]; parts?: DisplayParts }
export interface ExpressionInfo extends ValueInfo { sources: string[]; nodes: number; ast: ISequelizable; scalarQuery: boolean; dependencies: Dependency[]; tables: Map<string, Set<string>> }
export interface ExpressionIssue { code: 'invalid_expression'; entity: string; field: string; message: string; suggestedFix: string }
export class ExpressionError extends Error {
  readonly code = 'invalid_expression'
  constructor(public errors: ExpressionIssue[]) { super(errors.map(issue => `${issue.message} Fix: ${issue.suggestedFix}`).join('\n')) }
}
export function expressionError(entity: string, field: string, message: string, suggestedFix = 'Use schema fields and structured ts-query functions, then validate the proposal.'): never {
  throw new ExpressionError([{ code: 'invalid_expression', entity, field, message: `Invalid expression: ${entity}.${field}; ${message}`, suggestedFix }])
}
const functions = ['CONCAT', 'IFNULL', 'COALESCE', 'IF', 'LOWER', 'UPPER', 'TRIM', 'LTRIM', 'RTRIM', 'SUBSTRING', 'SUBSTR', 'LENGTH', 'REPLACE', 'STRFTIME', 'DATE', 'DATETIME', 'TIME', 'JULIANDAY', 'UNIXEPOCH', 'YEAR', 'MONTH', 'DATEADD', 'DATEDIFF', 'ABS', 'ROUND', 'MIN', 'MAX', 'SUM', 'COUNT', 'AVG', 'NULLIF']
/** Contracts target the SQLite/D1 renderer, rather than the library's cross-dialect API. */
const arities: Record<string, [number, number]> = {
  CONCAT: [1, 100], IFNULL: [2, 2], COALESCE: [2, 100], NULLIF: [2, 2], IF: [3, 3],
  LOWER: [1, 1], UPPER: [1, 1], TRIM: [1, 2], LTRIM: [1, 2], RTRIM: [1, 2],
  SUBSTRING: [2, 3], SUBSTR: [2, 3], LENGTH: [1, 1], REPLACE: [3, 3],
  STRFTIME: [2, 20], DATE: [1, 20], DATETIME: [1, 20], TIME: [1, 20],
  JULIANDAY: [1, 20], UNIXEPOCH: [1, 20], YEAR: [1, 1], MONTH: [1, 1], DATEADD: [3, 3],
  ABS: [1, 1], ROUND: [1, 2], MIN: [1, 100], MAX: [1, 100], SUM: [1, 1], COUNT: [1, 1], AVG: [1, 1],
}
const base: Record<string, Kind> = { id: 'string', organization_id: 'string', created_at: 'datetime', updated_at: 'datetime', version: 'number' }
const fieldKind = (config: Config, entity: string, field: string): Kind => (Object.hasOwn(base, field) ? base[field] : undefined) ?? ({ int: 'number', float: 'number', bool: 'bool', datetime: 'datetime' } as Record<string, Kind>)[config.entities[entity].fields[field]?.type] ?? 'string'
const cache = new WeakMap<Config, Map<string, ExpressionInfo>>()
/** Clone the validated AST, replacing operand nodes rather than identifier escaping.
 * Alias declarations are strings; ORDER BY aliases belong to their own SELECT.
 * Within a SELECT only `self` references bind to the outer entity; local aliases
 * may share their spelling with a ref path in the enclosing expression.
 */
export function rebindExpression<T>(node: T, columns: Map<string, string | ISequelizable>, inQuery = false, preserved = new Set<unknown>()): T {
  if (!node || typeof node !== 'object' || node instanceof Date || preserved.has(node)) return node
  if (node instanceof SelectQuery) {
    inQuery = true
    const aliases = new Set(node.getFields().map(field => field.alias).filter(alias => alias !== undefined))
    preserved = new Set(node.getOrderBy().filter(order => aliases.has(order.field.serialize())).map(order => order.field))
  } else if ('serialize' in node && typeof node.serialize === 'function') {
    const wire = node.serialize()
    const column = wire.match(/^#([^#]+)#$/)?.[1] ?? wire
    const mapped = !inQuery || column.startsWith('self.') ? columns.get(column) : undefined
    if (mapped) return (typeof mapped === 'string' ? Q.expr(mapped) : mapped) as T
  }
  if (Array.isArray(node)) return node.map(child => rebindExpression(child, columns, inQuery, preserved)) as T
  return Object.assign(Object.create(Object.getPrototypeOf(node)), Object.fromEntries(
    Object.entries(node).map(([key, child]) => [key, rebindExpression(child, columns, inQuery, preserved)]),
  ))
}
/** Validate the library wire grammar before deserializing. No arbitrary JS or SQL is interpreted.
 * Query aliases are lexical; an outer row is explicitly named `self` inside a subquery.
 */
export function expressionInfo(config: Config, entity: string, field: string, wire: string): ExpressionInfo {
  let entries = cache.get(config); if (!entries) { entries = new Map(); cache.set(config, entries) }
  const key = `${entity}.${field}:${wire}`; const known = entries.get(key); if (known) return known
  const fail = (message: string, fix?: string): never => expressionError(entity, field, message, fix)
  if (wire.length > 32000) fail('Expression exceeds 32000 bytes', 'Shorten the expression.')
  const sources: string[] = []; const dependencies: Dependency[] = []; const tables = new Map<string, Set<string>>(); let nodes = 0
  let hasSourceAggregate = false
  type Context = { aliases: Map<string, string>; aliasContexts: Map<string, string>; current?: string; query: boolean; rawRefs?: boolean;
    clause?: 'SELECT' | 'WHERE' | 'JOIN ON' | 'ORDER BY'; selectAggregate?: boolean;
    aggregate?: string; aggregates?: { found: boolean }; outerAliases?: Set<string>; outerReferences?: Set<string>;
    aggregateReferences?: { aliases: Set<string>; references: Set<string> }[] }
  const root: Context = { aliases: new Map([['self', entity]]), aliasContexts: new Map(), current: entity, query: false, rawRefs: config.entities[entity].fields[field]?.type === 'ref' }
  const reference = (column: string, context: Context): Kind => {
    if (column.includes('*') || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(column)) fail(`Unknown field: ${column}`)
    const parts = column.split('.'); let source = context.current ?? entity; let qualifier: string | undefined
    if (context.query && parts.length > 1 && !context.aliases.has(parts[0])) fail(`Unknown or unavailable schema table alias: ${parts[0]}`, 'Use an alias from FROM or an earlier/current JOIN; move a later JOIN before its first use.')
    if (parts.length > 1 && context.aliases.has(parts[0])) { qualifier = parts.shift()!; source = context.aliases.get(qualifier)! }
    if (qualifier && context.outerAliases?.has(qualifier)) context.outerReferences?.add(qualifier)
    if (qualifier) for (const aggregate of context.aggregateReferences ?? []) {
      if (aggregate.aliases.has(qualifier)) aggregate.references.add(qualifier)
    }
    if (context.query && !qualifier) fail(`Subquery field ${column} needs a schema table alias`, 'Qualify subquery fields, for example p.name; use self.id for the outer row.')
    const hops: Dependency['hops'] = []
    while (parts.length > 1) {
      const name = parts.shift()!; const spec = config.entities[source] && Object.hasOwn(config.entities[source].fields, name) ? config.entities[source].fields[name] : undefined
      if (spec?.type !== 'ref' || !spec.entity) fail(`Unknown ref path: ${source}.${name}`)
      hops.push({ source, field: name, target: spec!.entity! }); source = spec!.entity!
    }
    let name = parts[0]
    const spec = config.entities[source] && Object.hasOwn(config.entities[source].fields, name) ? config.entities[source].fields[name] : undefined
    if (!spec && !Object.hasOwn(base, name)) fail(`Unknown schema field: ${source}.${name}`, 'Choose a field returned by inspect_schema.')
    // Descriptive expressions consume the display value; computed refs consume IDs.
    if (spec?.type === 'ref' && !context.rawRefs) {
      if (qualifier && qualifier !== 'self') fail('Ref paths inside subqueries require an explicit schema join')
      hops.push({ source, field: name, target: spec!.entity! }); source = spec!.entity!
      name = config.entities[source].displayField ?? fail(`Referenced entity ${source} has no displayField`)
    }
    if (qualifier && qualifier !== 'self' && hops.length) fail('Ref paths inside subqueries require an explicit schema join')
    dependencies.push({ column, entity: source, field: name, hops, qualifier, sourcePath: qualifier ? context.aliasContexts.get(qualifier) : undefined })
    if (qualifier && qualifier !== 'self') { const fields = tables.get(source) ?? new Set<string>(); fields.add(name); tables.set(source, fields) }
    return fieldKind(config, source, name)
  }
  function scalar(node: unknown, context: Context, depth: number): ValueInfo {
    const result = scalarValue(node, context, depth)
    return { ...result, parts: result.parts ?? { wire: typeof node === 'string' ? node : Q.value(node as number | boolean).serialize(), type: result.calendarDate ? 'date' : result.type } }
  }
  function scalarValue(node: unknown, context: Context, depth: number): ValueInfo {
    if (++nodes > 512 || depth > 32) fail('Expression exceeds the complexity budget', 'Use fewer functions or subqueries.')
    if (typeof node === 'number') return { type: 'number', dateOnly: false }
    if (typeof node === 'boolean') return { type: 'bool', dateOnly: false }
    if (typeof node !== 'string') return fail('Unknown expression node')
    if (node.startsWith('!!!')) { const value = JSON.parse(node.slice(3)); if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) fail('Invalid literal'); return { type: value === null ? 'null' : typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'number' : 'string', dateOnly: false } }
    if (node.startsWith('!D!')) return { type: 'datetime', dateOnly: true }
    if (node.startsWith('FN(') || node.startsWith('OP(')) {
      if (!node.endsWith(')')) fail('Invalid function encoding')
      const [name, ...args] = JSON.parse(node.slice(3, -1)) as [string, ...unknown[]]
      if (typeof name !== 'string' || !(node.startsWith('OP(') ? ['+', '-', '*', '/'] : functions).includes(name.toUpperCase())) fail(`Unknown or unsafe function: ${name}`)
      const fn = name.toUpperCase()
      if (node.startsWith('FN(')) {
        if (!arities[fn]) fail(`${fn} is not supported by SQLite/D1`, `Use Fn.subtract(Q.expr('FN(["JULIANDAY","end"])'), Q.expr('FN(["JULIANDAY","start"])')) for a day difference.`)
        const [min, max] = arities[fn]
        if (args.length < min || args.length > max) fail(`${fn} expects ${min === max ? min : `${min}–${max}`} arguments; received ${args.length}`, `Supply ${fn} with its documented SQLite argument count.`)
      }
      // SQLite MIN/MAX with multiple arguments are scalar functions. A SELECT
      // below an aggregate starts a new context; scalar wrappers do not.
      const aggregate = node.startsWith('FN(') && (['SUM', 'COUNT', 'AVG'].includes(fn) || ['MIN', 'MAX'].includes(fn) && args.length === 1)
      if (aggregate && (context.clause === 'WHERE' || context.clause === 'JOIN ON')) fail(`Aggregate ${fn} is not allowed in ${context.clause}`, 'Wrap the aggregate in a separate scalar SELECT subquery and use its result in the condition.')
      if (aggregate && context.clause === 'ORDER BY' && !context.selectAggregate) fail(`Aggregate ${fn} in ORDER BY requires an aggregate in the SELECT projection`, 'Select an aggregate in this SELECT, or wrap the ORDER BY aggregate in a separate scalar SELECT subquery.')
      if (aggregate && context.aggregate) fail(`Nested aggregate ${fn} inside ${context.aggregate} in the same SELECT is not supported`, 'Move the inner aggregate into a separate SELECT subquery, or use one aggregate over a scalar expression.')
      if (aggregate && context.aggregates) context.aggregates.found = true
      const operandsScope = { aliases: new Set(context.aliases.keys()), references: new Set<string>() }
      const operandContext = aggregate ? { ...context, aggregate: fn, aggregateReferences: [...(context.aggregateReferences ?? []), operandsScope] } : context
      // COUNT(*) has no column operand and belongs to this SELECT, like COUNT(1).
      const values: ValueInfo[] = args.map(arg => fn === 'COUNT' && arg === '*' ? { type: 'number', dateOnly: false } : scalar(arg, operandContext, depth + 1))
      // SQLite moves an aggregate with exclusively outer column operands to an
      // enclosing SELECT, even across scalar wrappers or nested correlations.
      // Reject that shape before it can collapse entity rows or evade clause rules.
      if (aggregate && operandsScope.references.size && [...operandsScope.references].every(alias => context.outerAliases?.has(alias))) {
        fail(`Aggregate ${fn} references only outer query columns and belongs to an outer SELECT`, 'Aggregate a local FROM/JOIN column in this scalar SELECT; move the calculation outside the aggregate if it only needs the outer row.')
      }
      if (aggregate && context.query && !operandsScope.references.size && [...context.aliases.keys()].some(alias => !context.outerAliases?.has(alias))) hasSourceAggregate = true
      // Ordinary computed expressions are projected into each scoped entity row.
      // An aggregate here would change the cardinality of every list and count,
      // including when this expression is expanded through another computed field.
      if (aggregate && !context.query) fail(`Bare aggregate ${fn} inside a computed expression can change entity row cardinality`, 'Wrap the aggregate in an explicit scalar SELECT subquery, then reference that computed field for composition.')
      const operands = (indices: number[], kinds: Kind[], example: string) => {
        if (indices.some(i => ![...kinds, 'null'].includes(values[i].type))) fail(`${fn} operand type mismatch; expected ${kinds.join(' or ')}`, example)
      }
      const all = values.map((_, i) => i)
      const textDependencies = values.flatMap(value => value.textDependencies ?? [])
      if (['LOWER','UPPER','TRIM','LTRIM','RTRIM','REPLACE','LENGTH'].includes(fn)) operands(all, ['string'], `Use ${fn} with text fields and Q.value('text').`)
      if (['SUBSTR','SUBSTRING'].includes(fn)) { operands([0], ['string'], 'Use SUBSTR(text, numeric start, optional numeric length).'); operands(all.slice(1), ['number'], 'Use numeric substring positions.') }
      if (['SUM','AVG','ABS','ROUND'].includes(fn)) operands(all, ['number'], `Use ${fn} with numeric fields and Q.value(number).`)
      if (['STRFTIME','DATE','DATETIME','TIME','JULIANDAY','UNIXEPOCH','YEAR','MONTH','DATEADD'].includes(fn)) {
        const start = fn === 'STRFTIME' ? 1 : 0
        operands([start], ['datetime','string'], 'Use a datetime field or an ISO date string.')
        if (fn === 'STRFTIME') operands([0], ['string'], "Use Fn.strftime('%Y-%m-%d', 'date').")
        if (fn === 'DATEADD') {
          const literal = (arg: unknown) => typeof arg === 'string' && arg.startsWith('!!!') ? JSON.parse(arg.slice(3)) : undefined
          if (!Number.isSafeInteger(literal(args[1])) || !/^(year|month|day|hour|minute|second)s?$/.test(literal(args[2]) ?? '')) fail('DATEADD requires a literal integer interval and a supported literal unit', "Use Fn.dateAdd('date', 1, 'day').")
        } else operands(all.slice(start + 1), ['string'], "Use literal SQLite date modifier strings, for example Q.value('start of month').")
      }
      if (node.startsWith('OP(')) { if (values.length < 2 || values.some(value => !['number', 'null'].includes(value.type))) fail('Arithmetic type mismatch', 'Use numeric fields and Q.value(number).'); return { type: 'number', dateOnly: false } }
      if (fn === 'IF') { if (values.length !== 3 || values[0].type !== 'bool') fail('IF needs a condition and two values'); if (values[1].type !== values[2].type && !values.slice(1).some(value => value.type === 'null')) fail('IF branch type mismatch'); return { type: values[1].type === 'null' ? values[2].type : values[1].type, dateOnly: values.slice(1).every(value => value.dateOnly), calendarDate: values.slice(1).filter(value => value.type !== 'null').every(value => value.calendarDate), textDependencies: values.slice(1).flatMap(value => value.textDependencies ?? []), parts: { condition: typeof args[0] === 'string' ? args[0] : Q.value(args[0] as boolean).serialize(), yes: values[1].parts!, no: values[2].parts! } } }
      if (['IFNULL','COALESCE','NULLIF','MIN','MAX'].includes(fn)) { const nonnull = values.filter(value => value.type !== 'null'); if (new Set(nonnull.map(value => value.type)).size > 1) fail(`${fn} argument type mismatch`); return { type: nonnull[0]?.type ?? 'null', dateOnly: nonnull.every(value => value.dateOnly), calendarDate: (fn === 'NULLIF' ? [values[0]] : nonnull).every(value => value.calendarDate), textDependencies: fn === 'NULLIF' ? values[0].textDependencies : textDependencies, ...(['IFNULL', 'COALESCE'].includes(fn) ? { parts: { coalesce: values.map((value, i) => ({ wire: typeof args[i] === 'string' ? args[i] : Q.value(args[i] as number | boolean).serialize(), parts: value.parts! })) } } : {}) } }
      if (['COUNT','SUM','AVG','ABS','ROUND','LENGTH','JULIANDAY','UNIXEPOCH','YEAR','MONTH','DATEDIFF'].includes(fn)) return { type: 'number', dateOnly: false }
      if (['STRFTIME','DATE','DATETIME','TIME','DATEADD'].includes(fn)) return { type: fn === 'STRFTIME' ? 'string' : 'datetime', dateOnly: true, calendarDate: fn === 'DATE' }
      return { type: 'string', dateOnly: fn === 'CONCAT' && values.every(value => value.dateOnly || value.type === 'null'), textDependencies, ...(fn === 'CONCAT' ? { parts: { concat: values.map(value => value.parts!) } } : {}) }
    }
    if (node.startsWith('{')) return object(JSON.parse(node), context, depth + 1)
    if (/^[+-]?\d+(?:\.\d+)?$/.test(node)) return { type: 'number', dateOnly: false }
    if (node === 'NULL') return { type: 'null', dateOnly: false }
    if (/^&[^#]*&$/.test(node)) return { type: 'string', dateOnly: false } // Library Fn.string encoding.
    if (node.startsWith('!!')) fail('Raw SQL is forbidden; use structured ts-query expressions')
    const column = node.match(/^#([^#]+)#$/)?.[1] ?? node
    const type = reference(column, context); return { type, dateOnly: type === 'datetime', textDependencies: type === 'string' ? [dependencies[dependencies.length - 1]] : [] }
  }
  function object(node: any, parent: Context, depth: number): ValueInfo {
    if (++nodes > 512 || depth > 32) fail('Expression exceeds the complexity budget', 'Use fewer functions or subqueries.')
    if (!node || typeof node !== 'object' || Array.isArray(node)) return fail('Unknown node')
    if (node.type === 'SelectQuery') {
      if (depth > 4) fail('Subquery nesting exceeds the budget')
      if (node.unionQueries?.length || node.groupBy?.length || node.having?.length || node.offset) fail('Unsupported scalar subquery shape', 'Use one SELECT value, schema sources, WHERE, ORDER BY and LIMIT 1, or an aggregate.')
      if (node.fields?.length !== 1) fail('A scalar subquery must select exactly one field')
      const context: Context = { aliases: new Map(parent.aliases), aliasContexts: new Map(parent.aliasContexts), query: true,
        outerAliases: new Set(parent.aliases.keys()), outerReferences: new Set(), aggregateReferences: parent.aggregateReferences }
      const register = (table: any) => {
        if (table?.type !== 'Table' || typeof table.source !== 'string' || !Object.hasOwn(config.entities, table.source)) fail(`Unknown schema entity: ${table?.source}`, 'Use an entity returned by inspect_schema, never a physical/system table.')
        const alias = table.alias ?? table.source
        if (!/^[a-z][a-z0-9_]*$/.test(alias) || /^(scope_row_|computed_join_|expression_join_|label_join_)/.test(alias) || context.aliases.has(alias)) fail(`Invalid or shadowed subquery alias: ${alias}`)
        context.aliases.set(alias, table.source); context.aliasContexts.set(alias, `${sources.length}/${alias}`); sources.push(table.source); if (!tables.has(table.source)) tables.set(table.source, new Set())
      }
      for (const table of node.tables ?? []) register(table)
      // An ON clause can see the left-hand sources and its own right-hand source.
      // Validate it before registering later joins, including nested correlations.
      for (const join of node.joins ?? []) {
        if (!['INNER','LEFT','CROSS'].includes(join.joinType)) fail('Unsupported join')
        register(join.table)
        if (join.condition) object(join.condition, { ...context, clause: 'JOIN ON' }, depth + 1)
      }
      // Only mandatory equalities connect sources: OR and NOT cannot bound a join.
      const local = [...(node.tables ?? []), ...(node.joins ?? []).map((join: any) => join.table)].map((table: any) => table.alias)
      const edges: [string, string][] = []
      const endpoint = (column: unknown): { alias: string; indexed: boolean } | undefined => {
        if (typeof column !== 'string') return
        const parts = (column.match(/^#([^#]+)#$/)?.[1] ?? column).split('.')
        if (parts.length !== 2 || !context.aliases.has(parts[0])) return
        const source = context.aliases.get(parts[0])!; const spec = config.entities[source].fields[parts[1]]
        return { alias: parts[0], indexed: parts[1] === 'id' || spec?.type === 'ref' && !spec.computed }
      }
      const equality = (condition: any, rightAlias?: string) => {
        if (condition?.type === 'LogicalCondition' && condition.operator === 'AND') for (const child of condition.conditions ?? []) equality(child, rightAlias)
        if (condition?.type !== 'ColumnComparisonCondition' || condition.operator !== '=') return
        const left = endpoint(condition.leftKey); const right = endpoint(condition.rightKey)
        if (!left || !right || left.alias === right.alias || !(left.indexed || right.indexed)) return
        // A LEFT ON only bounds its own right-hand source. Its predicates do
        // not remove unmatched rows from sources already on the left.
        if (!rightAlias || right.alias === rightAlias) edges.push([left.alias, right.alias])
        if (!rightAlias || left.alias === rightAlias) edges.push([right.alias, left.alias])
      }
      for (const where of node.where ?? []) equality(where)
      for (const join of node.joins ?? []) {
        if (join.joinType === 'INNER') equality(join.condition)
        if (join.joinType === 'LEFT') equality(join.condition, join.table.alias)
      }
      for (const where of node.where ?? []) object(where, { ...context, clause: 'WHERE' }, depth + 1)
      const aggregates = { found: false }
      const result = scalar(node.fields[0].name, { ...context, clause: 'SELECT', aggregates }, depth + 1)
      for (const order of node.orderBy ?? []) {
        // An unqualified ORDER BY output alias names the projection, not a source
        // column. Validate that expression under this SELECT's aggregate context.
        const projection = node.fields.find((field: any) => field.alias === order.field)
        scalar(projection ? projection.name : order.field, { ...context, clause: 'ORDER BY', selectAggregate: aggregates.found }, depth + 1)
      }
      const correlated = parent.query && context.outerReferences!.size > 0
      const connected = new Set([...parent.aliases.keys(), ...(correlated ? [] : local.slice(0, 1))])
      let changed = true
      while (changed) { changed = false; for (const [from, to] of edges) if (connected.has(from) && !connected.has(to)) { connected.add(to); changed = true } }
      if (local.some((alias: string) => !connected.has(alias))) fail(correlated ? 'Nested correlated expression sources require a mandatory equality on id or a stored ref field' : 'Cartesian expression sources require an equality on id or a stored ref field', "Join each additional source or correlate it in WHERE, for example Cond.columnEqual('p2.id', 'p.id'); a LEFT JOIN ON only bounds its right-hand source.")
      if (node.limit !== 1 && !aggregates.found) fail('Scalar subquery needs LIMIT 1 or an aggregate', 'Add .limit(1), or select a single aggregate such as Fn.count; multi-argument MIN/MAX are scalar functions.')
      return { ...result, parts: { wire: JSON.stringify(node), type: result.calendarDate ? 'date' : result.type } }
    }
    const expr = (value: unknown) => scalar(value, { ...parent, rawRefs: true }, depth + 1)
    // Value slots use deserializeValue: plain strings are literal data, even
    // when they resemble functions or conditions. Typed/raw encodings still validate.
    const data = (value: unknown) => { if (typeof value === 'string' && (value.startsWith('!!') || value.startsWith('!D!'))) expr(value) }
    switch (node.type) {
      case 'BinaryCondition': expr(node.key); data(node.value); break
      case 'ColumnComparisonCondition': expr(node.leftKey); expr(node.rightKey); break
      case 'LogicalCondition': for (const child of node.conditions ?? []) object(child, parent, depth + 1); break
      case 'NotCondition': object(node.condition, parent, depth + 1); break
      case 'NullCondition': case 'LikeCondition': expr(node.key); break
      case 'BetweenCondition': expr(node.key); data(node.from); data(node.to); break
      case 'ExistsCondition': case 'NotExistsCondition': object(node.subquery, parent, depth + 1); break
      case 'InCondition': case 'NotInCondition': expr(node.key); if (node.subquery) object(node.subquery, parent, depth + 1); else (node.values ?? []).forEach(data); break
      default: fail(`Unknown node type: ${node.type}`)
    }
    return { type: 'bool', dateOnly: false }
  }
  try {
    // Follow the wire grammar, preserving value slots and LIKE patterns exactly.
    // Only expression operands can encode functions/conditions; table aliases
    // must survive the compiler's scoped-table transformation.
    const canonical = (node: any): any => {
      if (typeof node === 'string') {
        if (node.startsWith('{')) return JSON.stringify(canonical(JSON.parse(node)))
        if (node.startsWith('FN(') || node.startsWith('OP(')) {
          const [name, ...args] = JSON.parse(node.slice(3, -1))
          return `${node.slice(0, 3)}${JSON.stringify([typeof name === 'string' ? name.toUpperCase() : name, ...args.map(canonical)])})`
        }
        return node
      }
      if (!node || typeof node !== 'object') return node
      const result = { ...node }
      switch (node.type) {
        case 'Table': result.alias ??= result.source; break
        case 'SelectQuery':
          result.tables = node.tables?.map(canonical)
          result.fields = node.fields?.map((field: any) => ({ ...field, name: canonical(field.name) }))
          result.joins = node.joins?.map((join: any) => ({ ...join, table: canonical(join.table), condition: canonical(join.condition) }))
          result.where = node.where?.map(canonical)
          result.orderBy = node.orderBy?.map((order: any) => ({ ...order, field: canonical(order.field) }))
          break
        case 'BinaryCondition': case 'NullCondition': case 'LikeCondition': case 'BetweenCondition':
          result.key = canonical(node.key); break
        case 'ColumnComparisonCondition':
          result.leftKey = canonical(node.leftKey); result.rightKey = canonical(node.rightKey); break
        case 'LogicalCondition': result.conditions = node.conditions?.map(canonical); break
        case 'NotCondition': result.condition = canonical(node.condition); break
        case 'ExistsCondition': case 'NotExistsCondition': result.subquery = canonical(node.subquery); break
        case 'InCondition': case 'NotInCondition':
          result.key = canonical(node.key)
          if (node.subquery) result.subquery = canonical(node.subquery)
          break
      }
      return result
    }
    wire = canonical(wire)
    const scalarQuery = wire.trimStart().startsWith('{') && JSON.parse(wire).type === 'SelectQuery'
    const result = scalarQuery ? object(JSON.parse(wire), root, 0) : scalar(wire, root, 0)
    const wrapper = scalarQuery ? wire : JSON.stringify({ type: 'SelectQuery', tables: [], fields: [{ name: wire }] })
    const query = Q.deserialize(wrapper, { allowRaw: false, functions, maxDepth: 4 }) as SelectQuery
    // COUNT(1)/COUNT(*) depend on scoped source rows without naming a column.
    if (!dependencies.length && !hasSourceAggregate) fail('Expression must reference at least one schema field', 'Add a field operand such as title or customer.name.')
    const info = { sources, nodes, ast: scalarQuery ? query : query.getFields()[0].name as ISequelizable, scalarQuery, dependencies, ...result, parts: result.parts ?? { wire, type: result.calendarDate ? 'date' : result.type }, tables }
    entries.set(key, info); return info
  } catch (error) { if (error instanceof ExpressionError) throw error; return fail(`Raw SQL or invalid serialized node: ${error instanceof Error ? error.message : String(error)}`) }
}
export function fieldExpression(config: Config, entity: string, field: string): string | undefined {
  const spec = config.entities[entity]
  return spec.fields[field]?.computed ?? (spec.label && spec.displayField === field ? spec.label.serialize() : undefined)
}
export function validateComputedExpressions(config: InstanceConfig) {
  const visit = (entity: string, field: string, stack: string[]): { descriptive: boolean; hops: number } => {
    const key = `${entity}.${field}`
    if (stack.includes(key)) expressionError(entity, field, `Computed expression cycle: ${[...stack, key].join(' -> ')}`, 'Remove a circular field dependency.')
    const wire = fieldExpression(config, entity, field)
    if (!wire) return { descriptive: fieldKind(config, entity, field) === 'string', hops: 0 }
    const info = expressionInfo(config, entity, field, wire)
    const expected = fieldKind(config, entity, field)
    if (info.type !== 'null' && expected !== info.type) expressionError(entity, field, `Result type ${info.type} does not match field type ${expected}`, 'Change the field type or use an expression returning that type.')
    const next = [...stack, key]; let hops = 0
    const provenance = new Map<Dependency, boolean>()
    for (const dependency of info.dependencies) {
      let count = dependency.hops.length
      for (const hop of dependency.hops) if (fieldExpression(config, hop.source, hop.field)) count += visit(hop.source, hop.field, next).hops
      const result = visit(dependency.entity, dependency.field, next)
      hops = Math.max(hops, count + result.hops)
      provenance.set(dependency, result.descriptive)
    }
    return { descriptive: info.type === 'string' && !!info.textDependencies?.some(dep => provenance.get(dep)), hops }
  }
  for (const [entity, spec] of Object.entries(config.entities)) for (const [field, definition] of Object.entries(spec.fields)) if (definition.computed) {
    if (definition.default !== undefined || definition.backfillFrom || definition.renameFrom) expressionError(entity, field, 'Computed fields cannot have storage defaults, backfills or renames', 'Remove storage options; a computed ref must retain its target entity.')
    const result = visit(entity, field, [])
    if (field === spec.displayField) {
      if (result.hops > 1) expressionError(entity, field, 'displayField ref paths may traverse at most one hop', 'Use a direct ref and a target field without another ref traversal.')
      if (!result.descriptive) expressionError(entity, field, 'A displayField expression must produce descriptive text, not only a date or number', 'Concatenate the formatted date with a customer or service name.')
    }
  }
}
export function readableComputed(kernel: KernelRegistry, scope: Scope, entity: string, field: string, seen = new Set<string>()): boolean {
  const key = `${entity}.${field}`; if (seen.has(key)) return false
  if (!kernel.can(scope, entity, 'read') || !kernel.fieldMask(entity, scope).includes(field)) return false
  const spec = kernel.config.entities[entity]
  const reference = spec.fields[field]
  if (reference?.type === 'ref' && (!kernel.can(scope, reference.entity!, 'read') || !kernel.fieldMask(reference.entity!, scope).includes('id'))) return false
  const wire = reference?.computed
  if (!wire) return !spec.label || field !== spec.displayField || !!readableDisplay(kernel, scope, entity)
  const next = new Set(seen).add(key)
  const info = expressionInfo(kernel.config, entity, field, wire)
  return [...info.tables.keys()].every(source => kernel.can(scope, source, 'read') && kernel.fieldMask(source, scope).includes('id')) && info.dependencies.every(dep =>
    dep.hops.every(hop => kernel.fieldMask(hop.source, scope).includes(hop.field) && (!kernel.config.entities[hop.source].fields[hop.field].computed || readableComputed(kernel, scope, hop.source, hop.field, next)) && kernel.can(scope, hop.target, 'read') && kernel.fieldMask(hop.target, scope).includes('id')) && (!kernel.config.entities[dep.entity].fields[dep.field]?.entity || (kernel.can(scope, kernel.config.entities[dep.entity].fields[dep.field].entity!, 'read') && kernel.fieldMask(kernel.config.entities[dep.entity].fields[dep.field].entity!, scope).includes('id'))) && readableComputed(kernel, scope, dep.entity, dep.field, next))
}
