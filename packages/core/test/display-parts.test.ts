import { expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { defineInstance, Fn, Q, Cond } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { executeQuery } from '../src/query/executor'
import { consoleModel } from '../src/console-model'
import { setup, runtime } from '@workbasehq/test-support/helpers'
import { resolveActor, requireScope } from '../src/authorization'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { tenancy } from '../src/plugins'

const config = defineInstance({ id: 'display_parts', revision: 1, interactive: true, plugins: [identity, localAuth, tenancy, legacyPermissions], roles: ['owner'],
  entities: {
    cleaner: { displayField: 'name', fields: { name: { type: 'string' } } },
    booking: { displayField: Fn.concat('at', Q.value(' - '), 'cleaner').serialize(), fields: { at: { type: 'datetime' }, cleaner: { type: 'ref', entity: 'cleaner' } } },
    task: { displayField: 'title', relations: { booking: { entity: 'booking', field: 'booking', many: false } }, fields: { title: { type: 'string' }, booking: { type: 'ref', entity: 'booking' } } },
  }, permissions: { owner: { cleaner: ['read'], booking: ['read'], task: ['read'] } }, policies: { cleaner: { owner: 'all' }, booking: { owner: 'all' }, task: { owner: 'all' } },
  enumLabels: { cs: { entity_booking: 'Rezervace', entitySingular_booking: 'Rezervace' }, en: { entity_booking: 'Bookings', entitySingular_booking: 'Booking' } },
})
async function fixture() {
  await setup(config)
  const now = '2026-11-06T09:00:00.000Z'
  await env.DB.prepare('INSERT INTO cleaner(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('c', 'org-a', 'Jana', now, now).run()
  await env.DB.prepare('INSERT INTO booking(id,organization_id,at,cleaner,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('b', 'org-a', now, 'c', now, now).run()
  await env.DB.prepare('INSERT INTO task(id,organization_id,title,booking,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('t', 'org-a', 'Task', 'b', now, now).run()
  const kernel = new KernelRegistry(config)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const run = (input: unknown, current = kernel) => executeQuery(current, scope, env.DB, 'synthetic', input, { writeLog: () => {} })
  return { kernel, scope, run, now }
}
it('projects typed datetime parts alongside unchanged SQL values for lists, pickers and reference labels', async () => {
  const { run, now } = await fixture()
  const row = (await run({ entity: 'booking', select: ['id', 'computed_display'], search: { fields: ['computed_display'], text: 'Jana' }, limit: 10 })).data[0]
  expect(row.computed_display).toBe(`${now} - Jana`)
  expect(row.__display).toEqual([{ type: 'datetime', value: now }, ' - ', 'Jana'])
  const task = (await run({ entity: 'task', labels: ['booking'], limit: 10 })).data[0]
  expect(task.__labels.booking.row.__display).toEqual(row.__display)
  const limited = (await run({ entity: 'booking', select: ['id'], limit: 10 })).data[0]
  expect(limited).toEqual({ id: 'b' })
})
it('captions the generated display column with the localized singular entity label', async () => {
  const { kernel, scope } = await fixture()
  const labels = consoleModel(kernel, scope).model.enumLabels!
  expect(labels.cs.field_computed_display_booking).toBe('Rezervace')
  expect(labels.en.field_computed_display_booking).toBe('Booking')
})
it('resolves an assigned ordinary ref beside the computed display and masks denied presentation dependencies', async () => {
  const { kernel, run } = await fixture()
  expect((await run({ entity: 'booking', labels: ['cleaner'], limit: 10 })).data[0].__labels.cleaner.row).toEqual({ id: 'c', name: 'Jana' })
  const masked = new KernelRegistry(config, { plugins: [...config.plugins!, { name: 'deny_cleaner', version: '1', tableFilter: entity => ({ kind: entity === 'cleaner' ? 'none' : 'all' }) }] })
  const row = (await run({ entity: 'booking', labels: ['cleaner'], limit: 10 }, masked)).data[0]
  expect(row.computed_display).toBeNull()
  expect(row.__display).toBeUndefined()
  expect(row.__labels.cleaner).toEqual({ status: 'unavailable' })
  expect(kernel.config.revision).toBe(1)
})
it('retains presentation through computed refs and nested concat, and preserves numeric SQL text', async () => {
  await fixture()
  const nestedConfig = defineInstance({ ...config, entities: { ...config.entities,
    booking: { ...config.entities.booking, displayExpression: Fn.concat('at', Q.value(' - '), 'id', Q.value(' #'), 'number').serialize(), fields: { ...config.entities.booking.fields, number: { type: 'int', computed: Fn.add(Q.value(3), Q.value(1), 'version').serialize() } } },
    task: { ...config.entities.task, displayField: Fn.concat('booking', Q.value('!')).serialize() },
  } })
  const kernel = new KernelRegistry(nestedConfig)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const row = (await executeQuery(kernel, scope, env.DB, 'synthetic', { entity: 'task', limit: 10 }, { writeLog: () => {} })).data[0]
  expect(row.__display).toEqual([{ type: 'datetime', value: '2026-11-06T09:00:00.000Z' }, ' - ', 'b', ' #', '5.0', '!'])
  expect(row.computed_display).toBe('2026-11-06T09:00:00.000Z - b #5.0!')
})
it('preserves explicit STRFTIME text and chooses conditional/coalesce branches in SQL', async () => {
  const { now } = await fixture()
  const nestedConfig = defineInstance({ ...config, entities: { ...config.entities,
    booking: { ...config.entities.booking, displayExpression: Fn.if(Cond.isNotNull('at'), Fn.concat(Q.expr('FN(["COALESCE","at","NULL"])'), Q.value(' / '), Fn.strftime('%Y', 'at'), Q.value(' '), 'cleaner'), Q.value('hidden')).serialize() },
  } })
  const kernel = new KernelRegistry(nestedConfig)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), kernel.config), 'org-a', kernel.config)
  const row = (await executeQuery(kernel, scope, env.DB, 'synthetic', { entity: 'booking', limit: 10 }, { writeLog: () => {} })).data[0]
  expect(row.__display).toEqual([{ type: 'datetime', value: now }, ' / ', '2026', ' ', 'Jana'])
})

it('includes preserve typed display metadata through the ranked projection', async () => {
  const { run, now } = await fixture()
  const row = (await run({ entity: 'task', include: { booking: { select: ['id', 'computed_display'], limit: 1 } }, limit: 10 })).data[0]
  expect(row.booking.__display).toEqual([{ type: 'datetime', value: now }, ' - ', 'Jana'])
  const limited = (await run({ entity: 'task', include: { booking: { select: ['id'], limit: 1 } }, limit: 10 })).data[0]
  expect(limited.booking).toEqual({ id: 'b' })
})
it.each([
  ['DATEADD', Fn.dateAdd('at', 1, 'day'), 'datetime', '2026-11-06T23:30:00Z', '2026-11-06 23:30:00'],
  ['DATETIME', Q.expr('FN(["DATETIME","at"])'), 'datetime', '2026-11-05T23:30:00Z', '2026-11-05 23:30:00'],
  ['DATE', Q.expr('FN(["DATE","at"])'), 'date', '2026-11-05', '2026-11-05'],
])('%s preserves temporal presentation in root, reference labels and includes', async (_name, expression, type, value, raw) => {
  const { run } = await fixture()
  await env.DB.prepare('UPDATE booking SET at=?').bind('2026-11-05T23:30:00Z').run()
  const kernel = new KernelRegistry(defineInstance({ ...config, entities: { ...config.entities,
    booking: { ...config.entities.booking, displayExpression: Fn.concat(expression, Q.value(' - '), 'cleaner').serialize() },
  } }))
  const expected = [{ type, value }, ' - ', 'Jana']
  const row = (await run({ entity: 'booking', limit: 10 }, kernel)).data[0]
  expect(row.computed_display).toBe(`${raw} - Jana`)
  expect(row.__display).toEqual(expected)
  const task = (await run({ entity: 'task', labels: ['booking'], include: { booking: { select: ['id', 'computed_display'], limit: 1 } }, limit: 10 }, kernel)).data[0]
  expect(task.__labels.booking.row.__display).toEqual(expected)
  expect(task.booking.__display).toEqual(expected)
  await env.DB.prepare('UPDATE booking SET at=NULL').run()
  const empty = (await run({ entity: 'booking', limit: 10 }, kernel)).data[0]
  expect(empty.__display).toEqual([{ type, value: null }, ' - ', 'Jana'])
})
