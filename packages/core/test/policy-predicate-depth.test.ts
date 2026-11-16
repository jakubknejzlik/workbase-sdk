import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { renderPredicate } from '../src/kernel/predicate'
import type { Predicate } from '../src/kernel/plugin'

beforeEach(async () => { await setup() })

it.each([
  ['64 distinct', 64, true, ['id', 'team_id']],
  ['64 distinct id-only', 64, true, ['id']],
  ['64 repeated id-only', 64, false, ['id']],
  ['400 repeated', 400, false, ['id', 'team_id']],
] as const)('wide FK target policy succeeds: %s', async (_label, length, distinct, select) => {
  const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies,
    records: { ...policyGraph.policies.records, reviewer: 'all' },
    teams: { ...policyGraph.policies.teams, reviewer: { where: { or: Array.from({ length }, (_, i) => ({ name: distinct ? { ne: `blocked-${i}` } : { isNull: false } })) } } },
  } })
  const response = await request(createApp(config, runtime()), '/query', 'POST', { entity: 'records', limit: 10, select }, 'reviewer')
  expect(response.status).toBe(200)
  const rows = [{ id: 'record-CANARY_ROW', team_id: 'team-b' }, { id: 'record-colleague', team_id: 'team-a' }, { id: 'record-own', team_id: 'team-a' }]
  expect((await json(response)).data).toEqual(select.length === 1 ? rows.map(({ id }) => ({ id })) : rows)
})

it('wide FK target policy keeps denied, missing and cross-tenant targets masked', async () => {
  // Use an unconstrained fixture copy to represent legacy dangling references.
  await env.DB.exec("ALTER TABLE records RENAME TO original_records; CREATE TABLE records AS SELECT * FROM original_records; INSERT INTO records (id,organization_id,name,team_id,created_at,updated_at) VALUES ('record-missing','org-a','Missing','absent','now','now'),('record-cross','org-a','Cross','team-canary','now','now');")
  const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies,
    records: { ...policyGraph.policies.records, reviewer: 'all' },
    teams: { ...policyGraph.policies.teams, reviewer: { where: { or: Array.from({ length: 130 }, () => ({ name: { ne: 'CANARY_TEAM' } })) } } },
  } })
  const response = await request(createApp(config, runtime()), '/query', 'POST', { entity: 'records', limit: 10, select: ['id', 'team_id'] }, 'reviewer')
  expect(response.status).toBe(200)
  expect((await json(response)).data).toEqual([
    { id: 'record-CANARY_ROW', team_id: null }, { id: 'record-colleague', team_id: 'team-a' },
    { id: 'record-cross', team_id: null }, { id: 'record-missing', team_id: null }, { id: 'record-own', team_id: 'team-a' },
  ])
})

it.each(['and', 'or'] as const)('wide NOT/%s policy preserves mixed SQL NULL semantics and client parity', async combinator => {
  await env.DB.prepare("UPDATE users SET team_id=NULL WHERE id='assignable'").run()
  const children = [{ team_id: { eq: 'team-a' } }, { name: { eq: 'reviewer-other' } }]
  const narrow = { not: { [combinator]: children } }
  const wide = { not: { [combinator]: Array.from({ length: 130 }, (_, i) => children[i % children.length]) } }
  const app = (where: typeof wide | undefined) => createApp(defineInstance({ ...policyGraph, policies: { ...policyGraph.policies,
    users: { ...policyGraph.policies.users, reviewer: where ? { where } : 'all' },
    // Compare real NULLs; client filters otherwise see masked team references.
    teams: { ...policyGraph.policies.teams, reviewer: 'all' },
  } }), runtime())
  const input = { entity: 'users', limit: 100, select: ['id'] }
  const policy = await request(app(wide), '/query', 'POST', input, 'reviewer')
  const client = await request(app(undefined), '/query', 'POST', { ...input, where: narrow }, 'reviewer')
  expect(policy.status).toBe(200); expect(client.status).toBe(200)
  const rows = (await json(policy)).data
  expect(rows).toEqual((await json(client)).data)
  // NULL AND FALSE is FALSE; NULL OR FALSE is UNKNOWN. NOT must retain that distinction.
  expect(rows.some((row: { id: string }) => row.id === 'assignable')).toBe(combinator === 'and')
  expect(rows.some((row: { id: string }) => row.id === 'operator-other')).toBe(true)
})

it('implicit scalar AND handles 130 leaves on native D1', async () => {
  const fields = Array.from({ length: 65 }, (_, i) => `f${i}`)
  await env.DB.exec(`CREATE TABLE wide_scalars (${fields.map(field => `${field} TEXT`).join(',')}); INSERT INTO wide_scalars VALUES (${fields.map(() => "'present'").join(',')});`)
  const predicate = Object.fromEntries(fields.map(field => [field, { isNull: false, ne: null }]))
  for (const [node, expected] of [[predicate, 1], [{ not: predicate }, 0]] as const) {
    const rendered = renderPredicate(node, 'wide_scalars')
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM wide_scalars WHERE ${rendered.sql}`).first('n')).toBe(expected)
  }
})

it('balanced groups retain left-to-right binding order across NOT, scalars and empty identities', async () => {
  const node: Predicate = { all: [
    { name: { contains: 'first', ne: 'second' }, id: { in: ['third', null] } },
    { any: [{ not: { name: { eq: 'fourth', contains: 'fifth' } } }, { id: { eq: 'sixth' } }, { name: { ne: 'seventh' } }] },
    { all: [] },
  ] }
  const expected = ['first', 'second', '["third"]', 'fourth', 'fifth', 'sixth', 'seventh']
  expect(renderPredicate(node, 'records').bindings).toEqual(expected)
  const bound: unknown[] = []
  const rendered = renderPredicate(node, 'records', value => { bound.push(value); return `?${bound.length}` })
  expect(bound).toEqual(expected); expect(rendered.bindings).toEqual([])
  expect([...rendered.sql.matchAll(/\?(\d+)/g)].map(match => Number(match[1]))).toEqual([1, 2, 3, 4, 5, 6, 7])
  for (const [predicate, expected] of [[{ all: [] }, 1], [{ any: [] }, 0], [{ not: { all: [] } }, 0], [{ not: { any: [] } }, 1]] as const) {
    const { sql } = renderPredicate(predicate as Predicate, 'records')
    expect(await env.DB.prepare(`SELECT ${sql} AS decision`).first('decision')).toBe(expected)
  }
})
