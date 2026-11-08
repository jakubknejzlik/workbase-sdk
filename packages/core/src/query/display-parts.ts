import { Condition, Q, type ISequelizable, type ISQLFlavor, type SelectQuery } from '@jakub.knejzlik/ts-query'
import { expressionInfo, rebindExpression, type DisplayParts } from './expressions'
import type { InstanceConfig } from '../config'

/** Presentation is additive: raw SQL values still own search, ordering and cursors.
 * JSON arrays preserve typed date operands without interpreting an expression in JS.
 * Locale and timezone belong to the browser's ordinary field formatter.
 */
export const partsAlias = (field: string) => `__parts_${field}`
const needsCache = new WeakMap<object, Map<string, boolean>>()
export function needsDisplayParts(config: Pick<InstanceConfig, 'entities'>, entity: string, field: string): boolean {
  let cache = needsCache.get(config); if (!cache) { cache = new Map(); needsCache.set(config, cache) }
  const key = `${entity}.${field}`; const known = cache.get(key); if (known !== undefined) return known
  const wire = config.entities[entity].fields[field]?.computed
  if (!wire) { cache.set(key, false); return false }
  const info = expressionInfo(config, entity, field, wire)
  const containsDate = (parts: DisplayParts): boolean => 'concat' in parts ? parts.concat.some(containsDate)
    : 'condition' in parts ? containsDate(parts.yes) || containsDate(parts.no)
    : 'coalesce' in parts ? parts.coalesce.some(item => containsDate(item.parts))
    : parts.type === 'datetime' || parts.type === 'date'
  const result = containsDate(info.parts!) || info.dependencies.some(dep => needsDisplayParts(config, dep.entity, dep.field))
  cache.set(key, result); return result
}
export class DisplayPartsExpression extends Condition {
  constructor(private parts: DisplayParts, private columns: Map<string, string | ISequelizable>, private nested: Map<string, ISequelizable>, private source: (entity: string) => SelectQuery) { super() }
  toSQL(flavor: ISQLFlavor) {
    const raw = (wire: string) => {
      const query = wire.startsWith('{') && JSON.parse(wire).type === 'SelectQuery'
      const ast = query ? Q.deserialize(wire, { allowRaw: false }) : Q.expr(wire)
      const sql = rebindExpression(ast, this.columns).toSQL(flavor, { transformTable: this.source })
      return query ? `(${sql})` : sql
    }
    const render = (parts: DisplayParts): string => {
      if ('concat' in parts) return `json_array(${parts.concat.map(child => `json(${render(child)})`).join(', ')})`
      if ('condition' in parts) return `CASE WHEN ${raw(parts.condition)} THEN ${render(parts.yes)} ELSE ${render(parts.no)} END`
      if ('coalesce' in parts) return `CASE ${parts.coalesce.map(item => `WHEN ${raw(item.wire)} IS NOT NULL THEN ${render(item.parts)}`).join(' ')} ELSE json_array(NULL) END`
      const nested = this.nested.get(parts.wire.match(/^#([^#]+)#$/)?.[1] ?? parts.wire)
      if (nested) return nested.toSQL(flavor)
      const sql = raw(parts.wire)
      return parts.type === 'datetime' || parts.type === 'date' ? `json_array(json_object('type', '${parts.type}', 'value', ${sql}))` : `json_array(CAST(${sql} AS TEXT))`
    }
    return render(this.parts)
  }
}
/** Flatten SQL's nested concat arrays once, before sending the typed wire value. */
export function parseDisplayParts(value: string | unknown[]): unknown[] {
  return (typeof value === 'string' ? JSON.parse(value) as unknown[] : value).flat(Infinity).map(part => {
    // SQLite DATETIME/DATEADD return UTC timestamps without an offset. Qualify
    // only presentation values; raw SQL text still owns search and ordering.
    if (part && typeof part === 'object' && 'type' in part && part.type === 'datetime' && 'value' in part && typeof part.value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(part.value)) return { ...part, value: `${part.value.replace(' ', 'T')}Z` }
    return part == null ? '' : part
  })
}
