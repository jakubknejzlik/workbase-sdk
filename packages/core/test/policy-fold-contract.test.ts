import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { defineInstance, type Operation } from '../src/config'
import { createApp } from '../src/app'
import { request } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup() })

for (const deny of ['empty', 'forbidden'] as const) {
  for (const readGrant of [true, false]) {
    it(`folded false contract: deny=${deny}, coarse read=${readGrant}`, async () => {
      const observations = []
      // Both many/some and to-one compile to EXISTS; neither may retain where semantics.
      for (const where of [{ id: { in: [] } }, { jobs: { some: { id: { in: [] } } } }, { team: { id: { in: [] } } }]) {
        const operations: Operation[] = readGrant ? ['read', 'create', 'update', 'delete'] : ['create', 'update', 'delete']
        const config = defineInstance({ ...policyGraph,
          permissions: { ...policyGraph.permissions, reviewer: { ...policyGraph.permissions.reviewer, records: operations } },
          policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where, deny, fields: ['id', 'name'] } } },
        })
        const app = createApp(config, runtime())
        const responses = []
        for (const [path, method, body] of [
          ['/api/records', 'GET'], ['/api/records/record-own', 'GET'],
          ['/api/records/record-own', 'PATCH', { name: 'Denied', version: 1 }],
          ['/api/records/record-own', 'DELETE'],
          ['/api/records', 'POST', { name: 'Denied', team_id: 'team-a' }],
        ] as const) {
          const response = await request(app, path, method, body, 'reviewer')
          responses.push({ status: response.status, body: await response.text() })
        }
        const capabilityResponse = await request(app, '/o/org-a/capabilities', 'GET', undefined, 'reviewer')
        expect(capabilityResponse.status).toBe(200)
        const capability = (await capabilityResponse.json() as any).entities.records
        const audit = await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')
        observations.push(JSON.stringify({ responses, capability, audit }))
        expect(responses.map(response => ({ status: response.status, ...JSON.parse(response.body) }))).toEqual([
          deny === 'empty' ? { status: 200, data: [], next_cursor: null } : { status: 403, error: 'policy_violation', path: [] },
          deny === 'empty' ? { status: 404, error: 'not_found' } : { status: 403, error: 'policy_violation', path: [] },
          ...Array.from({ length: 3 }, () => ({ status: 403, error: 'permission_denied' })),
        ])
        expect(capability).toEqual({ operations: [], readable: ['id', 'name'], writable: ['name', 'team_id'], displayField: 'name' })
        expect(audit).toBe(0)
      }
      // Compare serialized bodies as well as the pinned status/error/metadata contract.
      expect(observations[1]).toBe(observations[0])
      expect(observations[2]).toBe(observations[0])
    })
  }
}
