import { expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import config from '../../../core/test/fixtures/sample/config'
import { D1AtomicStore } from '@workbasehq/core/execution/d1'
import { request, setup } from '@workbasehq/test-support/helpers'

it('rejects a rename when organizations.update is revoked after authorization and before commit', async () => {
  const app = await setup(config)
  const name = await env.DB.prepare('SELECT name FROM organizations WHERE id=?').bind('org-a').first('name')
  const run = D1AtomicStore.prototype.run
  const commit = vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementation(async function (this: D1AtomicStore, plan) {
    if (plan.rules.some(rule => rule.name === 'organization_update')) {
      // Both route and executor authorization have succeeded; revoke the live
      // membership's grant immediately before the guarded D1 batch executes.
      await env.DB.prepare('UPDATE memberships SET role=? WHERE organization_id=? AND user_id=?').bind('viewer', 'org-a', 'owner-a').run()
    }
    return run.call(this, plan)
  })
  try {
    const response = await request(app, '/organizations/org-a', 'PATCH', { name: 'Revoked rename' })
    expect({
      status: response.status,
      body: await response.json(),
      name: await env.DB.prepare('SELECT name FROM organizations WHERE id=?').bind('org-a').first('name'),
    }).toEqual({ status: 409, body: { error: 'organization_conflict' }, name })
  } finally { commit.mockRestore() }
})
