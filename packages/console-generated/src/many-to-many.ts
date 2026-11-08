import { readableRelations, type Model, type Capabilities, type Relation, type ReadQuery, type Result } from './read'

type Request = (query: ReadQuery) => Promise<Result>
type Row = Record<string, any>
export function editableManyRelations(model: Model, entity: string, caps: Capabilities) {
  return readableRelations(model, entity, caps).filter(([, relation]) => relation.through && [relation.through.createCommand, relation.through.deleteCommand].every(command => caps.commands?.includes(command)))
}
export function manyRelationSchema<T extends Record<string, any>>(schema: T, relations: [string, Relation][]) {
  return { ...schema, properties: { ...schema.properties, ...Object.fromEntries(relations.map(([name]) => [name, { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, default: [], 'x-ui': { span: 'full' } }])) } }
}
/** Follow every join cursor before diffing; a detail preview is never a complete set. */
export async function memberships(model: Model, relation: Relation, id: string, request: Request): Promise<Row[]> {
  const rows: Row[] = []; let cursor: string | undefined
  do {
    const page = await request({ entity: relation.entity, select: ['id', relation.field, relation.through!.field], limit: model.limits.root, where: { [relation.field]: { eq: id } }, orderBy: [{ field: 'id', dir: 'asc' }], ...(cursor ? { cursor } : {}) })
    rows.push(...page.data); cursor = page.next_cursor ?? undefined
  } while (cursor)
  return rows
}
export function membershipDiff(relation: Relation, rows: Row[], desired: string[]) {
  const wanted = new Set(desired); const existing = new Set(rows.map(row => String(row[relation.through!.field])))
  const kept = new Set<string>()
  return {
    add: [...wanted].filter(id => !existing.has(id)),
    remove: rows.filter(row => { const id = String(row[relation.through!.field]); if (!wanted.has(id) || kept.has(id)) return true; kept.add(id); return false }),
  }
}
export async function syncMemberships(model: Model, relation: Relation, id: string, desired: string[], request: Request, write: (path: string, method: string, body: unknown) => Promise<any>) {
  const through = relation.through!
  const diff = membershipDiff(relation, await memberships(model, relation, id, request), desired)
  // Add first: a failed addition never removes an existing membership.
  for (const target of diff.add) {
    try { await write(`/commands/${through.createCommand}`, 'POST', { [relation.field]: id, [through.field]: target }) }
    catch (error) {
      // Concurrent duplicate creation is success only after an authorized reread proves it.
      if (!(await memberships(model, relation, id, request)).some(row => row[through.field] === target)) throw error
    }
  }
  for (const row of diff.remove) {
    try { await write(`/commands/${through.deleteCommand}`, 'POST', { id: row.id }) }
    catch (error) { if ((await memberships(model, relation, id, request)).some(current => current.id === row.id)) throw error }
  }
}
export function relationEmptyKey(entity: string, name: string) { return `relationEmpty_${entity}_${name}` }
