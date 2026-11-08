import { assertActorFields } from './policies'
import { enforcePlan, writeFilter } from './execution/policies'
import { compile } from './execution/compiler'
import type { GuardedStatement } from './execution/types'
import { z } from 'zod'
import { fieldsFor } from './query/schema'
import { restQuery } from './query/facade'
import { executeQuery } from './query/executor'
import { observeQuery } from './query/observability'
import { cursorSecret } from './query/routes'
import { requestHash } from './idempotency'
import { kernelFor } from './kernel/registry'
import { bodyValidator, type InstanceConfig, type Operation } from './config'
import type { App, AppContext, RuntimeEnv, Scope } from './types'
import { ApiError } from './errors'
import { makeEvent, type AuditEvent } from './events'
import { publishCommittedEvents } from './event-delivery'
import { quote } from './migrations/schema'
import { assertUnprotectedFields } from './user-links'
type Row = Record<string, any>
export function permission(config: InstanceConfig, scope: Scope, entity: string, op: Operation) {
  kernelFor(config).permission(scope, entity, op)
}
export function serialize(config: InstanceConfig, name: string, row: Row) {
  const out: Row = Object.fromEntries(fieldsFor(config, name).filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))
  for (const [key, f] of Object.entries(config.entities[name].fields)) if (f.type === 'bool' && Object.hasOwn(out, key) && out[key] !== null) out[key] = Boolean(out[key])
  return out
}
export function crudRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  const kernel = kernelFor(config)
  const storedFields = (name: string) => fieldsFor(config, name).filter(field => !config.entities[name].fields[field]?.computed).filter(field => !config.entities[name].label || field !== config.entities[name].displayField)
  const responseRow = async (name: string, scope: Scope, row: Row) => {
    const readable = new Set(kernel.fieldMask(name, scope))
    const result = Object.fromEntries(Object.entries(serialize(config, name, row)).filter(([field]) => readable.has(field)))
    // Stored mutation/replay bodies retain their original values, but references
    // must pass the same current target visibility check as query projections.
    for (const [field, definition] of Object.entries(config.entities[name].fields)) {
      if (definition.type !== 'ref' || result[field] == null) continue
      const target = definition.entity!
      if (!kernel.can(scope, target, 'read') || !kernel.fieldMask(target, scope).includes('id')) { result[field] = null; continue }
      const policy = writeFilter(kernel, scope, target)
      const visible = await env.DB.prepare(`SELECT id FROM ${quote(target)} WHERE id=? AND (${policy.sql})`).bind(result[field], ...(policy.bindings ?? [])).first()
      if (!visible) result[field] = null
    }
    return result
  }
  async function mutate(name: string, scope: Scope, statement: GuardedStatement, event: AuditEvent, tail: D1PreparedStatement[] = []) {
    const plan = enforcePlan(kernel, scope, { rules: [{ name: 'crud_write', statements: [{ ...statement, expectRows: 1 }] }], event: { entity: name, entityId: '', operation: 'crud' }, result: { status: 200, body: {} } })
    const sql = compile({ runId: crypto.randomUUID(), rules: plan.rules })
    const cleanup = sql.pop()!
    try { await env.DB.batch([...sql.map(s => env.DB.prepare(s.sql).bind(...(s.bindings ?? []))), env.DB.prepare('INSERT INTO audit_outbox (event_id,organization_id,payload,created_at) VALUES (?,?,?,?)').bind(event.event_id, event.organization_id, JSON.stringify(event), event.occurred_at), ...tail, env.DB.prepare(cleanup.sql).bind(...(cleanup.bindings ?? []))]) }
    catch (error) {
      if (/CHECK constraint failed: policy_ok\s*=\s*1/i.test(String(error))) throw new ApiError(403, 'policy_violation')
      if (/CHECK constraint failed: actor_ok\s*=\s*1/i.test(String(error))) throw new ApiError(403, 'field_forbidden')
      if (/CHECK constraint failed: (?:atomic_assert|ok\s*=\s*1)/i.test(String(error))) throw new ApiError(409, 'version_conflict')
      throw error
    }
    await publishCommittedEvents(env, config, [event])
  }
  function hidden(name: string, scope: Scope): never {
    const filter = kernel.tableFilter(name, scope)
    throw new ApiError('deny' in filter && filter.deny === 'forbidden' ? 403 : 404, 'deny' in filter && filter.deny === 'forbidden' ? 'policy_violation' : 'not_found')
  }
  function entity(c: AppContext, op: Operation) {
    const name = c.req.param('entity')!; const definition = config.entities[name]
    if (!Object.hasOwn(config.entities, name)) throw new ApiError(404, 'entity_not_found')
    const scope = c.get('scope')
    if (op === 'read') kernel.readPermission(scope, name)
    else kernel.permission(scope, name, op)
    if (op !== 'read' && definition.commandsOnly) throw new ApiError(405, 'commands_only', 'Use a registered /commands/:name command')
    return { name, definition, scope, table: quote(name) }
  }
  app.get('/api/:entity', c => observeQuery(env.DB, c.get('scope'), async (writeLog, rejectedInput) => {
    await rejectedInput({ entity: c.req.param('entity'), id: c.req.param('id'), params: c.req.query() })
    const { name, scope } = entity(c, 'read')
    const query = restQuery(config, name, c.req.query())
    const result = await executeQuery(kernel, scope, env.DB, await cursorSecret(env), query, { legacyErrors: true, writeLog })
    return c.json({ data: result.data, next_cursor: result.next_cursor ? result.data.at(-1)!.id : null })
  }))
  app.get('/api/:entity/:id', c => observeQuery(env.DB, c.get('scope'), async (writeLog, rejectedInput) => {
    await rejectedInput({ entity: c.req.param('entity'), id: c.req.param('id'), params: c.req.query() })
    const { name, scope } = entity(c, 'read')
    const result = await executeQuery(kernel, scope, env.DB, await cursorSecret(env), restQuery(config, name, c.req.query(), c.req.param('id')), { legacyErrors: true, writeLog })
    if (!result.data.length) throw new ApiError(404, 'not_found')
    return c.json(result.data[0])
  }))
  app.post('/api/:entity', async c => {
    const { name, definition, scope, table } = entity(c, 'create')
    const raw = z.record(z.string(), z.unknown()).parse(await c.req.json()) as Row
    assertUnprotectedFields(definition, Object.keys(raw))
    const body = bodyValidator(definition).parse(raw) as Row
    const key = z.string().min(1).max(128).optional().parse(c.req.header('Idempotency-Key'))
    const operation = `${name}.create`
    const hash = key ? await requestHash(operation, body) : undefined
    const replay = async () => {
      if (!key) return null
      const stored = await env.DB.prepare('SELECT command,request_hash,response_json FROM idempotency_keys WHERE organization_id=? AND key=?').bind(scope.organizationId, key).first<{ command: string; request_hash: string; response_json: string }>()
      if (!stored) return null
      if (stored.command !== operation || stored.request_hash !== hash) throw new ApiError(422, 'idempotency_payload_mismatch')
      const row = JSON.parse(stored.response_json).body as Row
      const policy = writeFilter(kernel, scope, name)
      const visible = await env.DB.prepare(`SELECT id FROM ${table} WHERE id=? AND (${policy.sql})`).bind(row.id, ...(policy.bindings ?? [])).first()
      if (!visible) hidden(name, scope)
      return row
    }
    const prior = await replay()
    if (prior) return c.json(await responseRow(name, scope, prior), 201)
    const now = new Date().toISOString()
    const row: Row = { id: crypto.randomUUID(), organization_id: scope.organizationId, created_at: now, updated_at: now, version: 1 }
    for (const [key, f] of Object.entries(definition.fields)) if (!f.computed && (!definition.label || key !== definition.displayField)) row[key] = Object.hasOwn(body, key) ? body[key] : f.default ?? null
    const keys = Object.keys(row).filter(key => !definition.fields[key]?.userLink)
    assertActorFields(config, scope, name, Object.keys(body))
    try { await mutate(name, scope, { sql: `INSERT INTO ${table} (${keys.map(quote).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, bindings: keys.map(k => typeof row[k] === 'boolean' ? Number(row[k]) : row[k]) }, makeEvent(config, scope, `${name}.created`, name, row.id, {}, row), [
      ...(key ? [env.DB.prepare('INSERT INTO idempotency_keys (organization_id,key,command,response_json,request_hash) VALUES (?,?,?,?,?)').bind(scope.organizationId, key, operation, JSON.stringify({ status: 201, body: serialize(config, name, row) }), hash!)] : []),
    ]) } catch (error) {
      const winner = await replay()
      if (winner) return c.json(await responseRow(name, scope, winner), 201)
      throw error
    }
    return c.json(await responseRow(name, scope, row), 201)
  })
  app.patch('/api/:entity/:id', async c => {
    const { name, definition, scope, table } = entity(c, 'update')
    const raw = z.record(z.string(), z.unknown()).parse(await c.req.json()) as Row
    assertUnprotectedFields(definition, Object.keys(raw))
    const expected = Number(c.req.header('If-Match')?.replaceAll('"', '') ?? raw.version)
    if (!Number.isSafeInteger(expected) || expected < 1) throw new ApiError(400, 'version_required')
    delete raw.version
    assertActorFields(config, scope, name, Object.keys(raw), c.req.param('id'))
    const body = bodyValidator(definition, true).parse(raw) as Row
    if (!Object.keys(body).length) throw new ApiError(400, 'empty_update')
    const policy = writeFilter(kernel, scope, name)
    const before = await env.DB.prepare(`SELECT ${storedFields(name).map(quote).join(',')} FROM ${table} WHERE organization_id=? AND id=? AND (${policy.sql})`).bind(scope.organizationId, c.req.param('id'), ...(policy.bindings ?? [])).first<Row>()
    if (!before) hidden(name, scope)
    if (before.version !== expected) throw new ApiError(409, 'version_conflict')
    assertActorFields(config, scope, name, Object.keys(body), c.req.param('id'))
    const after: Row = { ...serialize(config, name, before), ...body, updated_at: new Date().toISOString(), version: expected + 1 }
    const keys = [...Object.keys(body), 'updated_at', 'version']
    await mutate(name, scope, { sql: `UPDATE ${table} SET ${keys.map(k => `${quote(k)}=?`).join(',')} WHERE organization_id=? AND id=? AND version=?`, bindings: [...keys.map(k => typeof after[k] === 'boolean' ? Number(after[k]) : after[k]), scope.organizationId, c.req.param('id'), expected] }, makeEvent(config, scope, `${name}.updated`, name, before.id, serialize(config, name, before), after))
    return c.json(await responseRow(name, scope, after))
  })
  app.delete('/api/:entity/:id', async c => {
    const { name, scope, table } = entity(c, 'delete')
    const policy = writeFilter(kernel, scope, name)
    const before = await env.DB.prepare(`SELECT ${storedFields(name).map(quote).join(',')} FROM ${table} WHERE organization_id=? AND id=? AND (${policy.sql})`).bind(scope.organizationId, c.req.param('id'), ...(policy.bindings ?? [])).first<Row>()
    if (!before) hidden(name, scope)
    await mutate(name, scope, { sql: `DELETE FROM ${table} WHERE organization_id=? AND id=? AND version=?`, bindings: [scope.organizationId, c.req.param('id'), before.version] }, makeEvent(config, scope, `${name}.deleted`, name, before.id, serialize(config, name, before)))
    return c.body(null, 204)
  })
}
