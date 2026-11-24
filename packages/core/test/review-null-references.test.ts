// Ported from the independent PR #160 review probe.
import { expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { defineInstance, Q } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import type { WorkbasePlugin } from '../src/kernel/plugin'
import { resolveActor, requireScope } from '../src/authorization'
import { executeQuery } from '../src/query/executor'
import { createApp } from '../src/app'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { tenancy } from '../src/plugins'
import { setup, runtime, request } from '@workbasehq/test-support/helpers'
import sample from './fixtures/sample/config'

const config = defineInstance({ id: 'review', revision: 1, interactive: true, plugins: [identity, localAuth, tenancy, rbac], roles: ['owner', 'viewer'],
  permissions: Object.fromEntries(['owner', 'viewer'].map(role => [role, { people: ['read'], notes: ['read'] }])),
  policies: { people: { owner: 'all', viewer: 'all' }, notes: { owner: 'all', viewer: 'all' } },
  entities: {
    people: { displayField: 'name', fields: { name: { type: 'string' }, parent: { type: 'ref', entity: 'people' } } },
    notes: { displayField: 'title', relations: { target: { entity: 'people', field: 'person', many: false } }, fields: {
      title: { type: 'string' }, person_key: { type: 'string' }, person: { type: 'ref', entity: 'people', computed: Q.expr('person_key').serialize() },
      alias: { type: 'ref', entity: 'people', computed: Q.expr('person').serialize() },
    } },
  },
  ui: { entities: { notes: { list: { columns: ['title', 'grandparent'], relatedColumns: { grandparent: { via: 'person', field: 'parent' } } } } } },
})
const restricted: WorkbasePlugin = { name: 'restricted', version: '1', tableFilter: entity => entity === 'people' ? { kind: 'where', predicate: { name: { ne: 'Secret' } } } : { kind: 'all' } }
const plugins = [...config.plugins!, restricted]
const kernel = new KernelRegistry(config, { plugins })
const liveScope = async (current = kernel) => requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-viewer-a' } }), runtime(), current.config), 'org-a', current.config)
const run = async (input: unknown, current = kernel) => executeQuery(current, await liveScope(current), env.DB, 'review', input, { writeLog: () => {} })

it('review restricted direct/related labels and real deletion', async () => {
  await setup(config)
  await env.DB.exec("INSERT INTO people(id,organization_id,name,created_at,updated_at) VALUES ('secret','org-a','Secret',datetime('now'),datetime('now')),('public','org-a','Public',datetime('now'),datetime('now'))")
  await env.DB.exec("INSERT INTO notes(id,organization_id,title,person_key,created_at,updated_at) VALUES ('n','org-a','Note','secret',datetime('now'),datetime('now'))")
  const query = { entity: 'notes', select: ['id', 'person', 'alias'], labels: ['person', 'alias', 'grandparent'], include: { target: { select: ['id', 'name'] } }, limit: 10 }
  const forbidden = await run(query)
  expect(forbidden.data[0]).toMatchObject({ person: null, __labels: { person: { status: 'unavailable' } }, target: null })
  await env.DB.exec("UPDATE notes SET person_key='public'")
  const visible = (await run(query)).data[0]
  expect(visible.__labels.person.status).toBe('ok')
  expect(visible.__labels.grandparent.status).toBe('empty')
  expect(visible.target).toEqual({ id: 'public', name: 'Public' })
  await env.DB.exec("DELETE FROM people WHERE id='public'")
  expect((await run(query)).data[0].__labels.person.status).toBe('unavailable')
  await env.DB.exec('UPDATE notes SET person_key=NULL')
  expect((await run(query)).data[0].__labels.grandparent.status).toBe('empty')
})
it('review computed alias keeps hidden non-null dependency unavailable', async () => {
  await setup(config)
  await env.DB.exec("INSERT INTO people(id,organization_id,name,created_at,updated_at) VALUES ('secret','org-a','Secret',datetime('now'),datetime('now'))")
  await env.DB.exec("INSERT INTO notes(id,organization_id,title,person_key,created_at,updated_at) VALUES ('n','org-a','Note','secret',datetime('now'),datetime('now'))")
  const query = { entity: 'notes', select: ['id', 'person', 'alias'], labels: ['person', 'alias'], limit: 10 }
  const forbidden = await run(query)
  expect(forbidden.data[0]).toEqual({ id: 'n', person: null, alias: null, __labels: { person: { status: 'unavailable' }, alias: { status: 'unavailable' } } })
  await env.DB.exec("DELETE FROM people WHERE id='secret'")
  expect(await run(query)).toEqual(forbidden)
})
it('review real dashboard null reference', async () => {
  const dashboard = defineInstance({ ...config, plugins: [...config.plugins!, ...sample.plugins!.filter(plugin => plugin.name === 'console'), {
    name: 'review-dashboard', version: '1', requires: { console: '^1' }, contributes: { console: { pages: [{ id: 'review.dashboard', path: '/review', label: 'Review', widgets: [
      { id: 'notes', kind: 'table', label: 'Notes', columns: ['person'], query: { entity: 'notes', select: ['id', 'person'], labels: ['person'], limit: 10 } },
    ] }] } },
  }] })
  await setup(dashboard)
  await env.DB.exec("INSERT INTO notes(id,organization_id,title,created_at,updated_at) VALUES ('n','org-a','Note',datetime('now'),datetime('now'))")
  const response = await request(createApp(dashboard, runtime()), '/o/org-a/console-pages/review.dashboard')
  const body: any = await response.json()
  expect(response.status).toBe(200)
  expect(body.widgets[0].data[0].__labels.person.status).toBe('empty')
})
it('review stored FK masks never distinguish missing and forbidden target existence', async () => {
  const physical = defineInstance({ ...config, entities: { ...config.entities, notes: { ...config.entities.notes, fields: { ...config.entities.notes.fields, stored_ref: { type: 'ref', entity: 'people' } } } } })
  await setup(config)
  // Match the review's unconstrained legacy FK, allowing a real target deletion.
  await env.DB.exec('ALTER TABLE notes ADD COLUMN stored_ref TEXT')
  const current = new KernelRegistry(physical, { plugins })
  await env.DB.exec("INSERT INTO people(id,organization_id,name,created_at,updated_at) VALUES ('secret','org-a','Secret',datetime('now'),datetime('now'))")
  await env.DB.exec("INSERT INTO notes(id,organization_id,title,stored_ref,created_at,updated_at) VALUES ('n','org-a','Note','secret',datetime('now'),datetime('now'))")
  const query = { entity: 'notes', select: ['id', 'stored_ref'], labels: ['stored_ref'], limit: 10 }
  const forbidden = await run(query, current)
  expect(forbidden.data[0]).toEqual({ id: 'n', stored_ref: null, __labels: { stored_ref: { status: 'unavailable' } } })
  await env.DB.exec("DELETE FROM people WHERE id='secret'")
  expect(await run(query, current)).toEqual(forbidden)
  await env.DB.exec('UPDATE notes SET stored_ref=NULL')
  expect((await run(query, current)).data[0].__labels.stored_ref).toEqual({ status: 'empty' })
})
