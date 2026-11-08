import { beforeEach, expect, it } from 'vitest'
import { setup, roles } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'

let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
it.each([...roles, 'unknown'])('session lookup reads expose only readable teams for %s', async role => {
  // This is the same root query used by the lookup cache, filters and form pickers.
  const response = await request(app, '/query', 'POST', { entity: 'teams', select: ['id', 'name'], limit: 100, orderBy: [{ field: 'id', dir: 'asc' }] }, role)
  expect(response.status).toBe(200)
  const body = await json(response)
  const ids = body.data.map((row: { id: string }) => row.id)
  expect(ids).toEqual(role === 'unknown' ? [] : ['reviewer', 'team_user'].includes(role) ? ['team-a'] : ['team-a', 'team-b'])
  expect(JSON.stringify(body)).not.toContain('CANARY_ORG')
  if (['unknown', 'reviewer', 'team_user'].includes(role)) expect(JSON.stringify(body)).not.toContain('CANARY_TEAM')
})
