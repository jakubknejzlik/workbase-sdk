import { beforeEach, expect, it } from 'vitest'
import { setup, runtime, policyGraph, roles } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'

beforeEach(async () => { await setup() })
it.each(roles)('every advertised readable field is selectable with an id-omitting allowlist for %s', async role => {
  const policy = policyGraph.policies.users[role]
  const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, users: { ...policyGraph.policies.users, [role]: { where: typeof policy === 'object' ? policy.where : {}, fields: ['name'] } } } })
  const app = createApp(config, runtime())
  const doc = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, role))
  expect(doc.entities.users.readable).toEqual(['id', 'name'])
  for (const [entity, capability] of Object.entries(doc.entities) as [string, any][]) {
    for (const field of capability.readable) {
      const response = await request(app, '/query', 'POST', { entity, select: [field], limit: 10 }, role)
      const body = await json(response)
      if (response.status === 200) expect(body.data.every((row: any) => Object.hasOwn(row, field))).toBe(true)
      else expect({ status: response.status, error: body.error }).toEqual({ status: 403, error: 'policy_violation' })
    }
  }
})
it('an empty field allowlist grants no id or read capability', async () => {
  const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, users: { reviewer: { where: {}, fields: [] } } } })
  const app = createApp(config, runtime())
  const doc = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, 'reviewer'))
  expect(doc.entities.users.readable).toEqual([])
  expect(doc.entities.users.operations).not.toContain('read')
})
