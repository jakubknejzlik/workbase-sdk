import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '@workbasehq/core/app'
import { request, runtime, setup } from '@workbasehq/test-support/helpers'
import { consoleRegistry } from '../src/index'
beforeEach(async () => { await setup() })
afterEach(() => vi.restoreAllMocks())
it('SR-85 Changes is registry-owned in Operations, admin-only, and endpoints recheck scope/grants', async () => {
  const app = createApp(sample, runtime())
  const registry = await (await request(app, '/o/org-a/console-registry')).json() as ReturnType<typeof consoleRegistry>
  expect(registry.navigation.find(item => item.page === 'console.changes')).toMatchObject({ placement: 'settings', group: { id: 'operations' } })
  for (const action of ['propose', 'apply']) {
    const path = `/o/org-a/config-changes/${action}`
    expect((await request(app, path, 'POST', { prompt: 'add status field with filter to jobs' }, 'viewer-a')).status).toBe(403)
    expect((await request(app, path.replace('org-a', 'org-b'), 'POST', {}, 'owner-a')).status).toBe(403)
    expect((await app.request(path, { method: 'POST' })).status).toBe(401)
    expect((await request(app, path, 'POST', action === 'propose' ? { prompt: 'add status field with filter to jobs' } : { proposalId: crypto.randomUUID() })).status).toBe(503)
  }
  const viewer = await (await request(app, '/o/org-a/console-registry', 'GET', undefined, 'viewer-a')).json() as ReturnType<typeof consoleRegistry>
  expect(viewer.pages.some(page => page.id === 'console.changes')).toBe(false)
  const headless = createApp({ ...sample, plugins: sample.plugins!.filter(p => !['console', 'audit'].includes(p.name)) }, runtime())
  expect((await request(headless, '/o/org-a/config-changes/propose', 'POST', {})).status).toBe(404)
})
it('SR-85 local editor forwards only trusted instance/action, private history and opaque apply IDs; deployed stages disable writes', async () => {
  const env = { ...runtime(), STAGE: 'local', CONFIG_EDITOR_URL: 'http://127.0.0.1:9345', CONFIG_EDITOR_TOKEN: 'synthetic-editor-token' }
  const app = createApp(sample, env)
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ revision: 4 }))
  const response = await request(app, '/o/org-a/config-changes/propose', 'POST', { prompt: 'add status field with filter to jobs' })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ action: 'propose', instance: 'sample', prompt: 'add status field with filter to jobs' })
  const proposalId = crypto.randomUUID()
  expect((await request(app, '/o/org-a/config-changes/apply', 'POST', { proposalId })).status).toBe(200)
  expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ action: 'apply', instance: 'sample', proposalId })
  expect((await request(app, '/o/org-a/config-versions')).status).toBe(200)
  expect(JSON.parse(fetch.mock.calls[2][1]!.body as string)).toEqual({ action: 'history', instance: 'sample' })
  expect((await request(app, '/o/org-a/config-changes/apply', 'POST', { proposalId, patch: [] })).status).toBe(400)
  expect((await request(createApp(sample, { ...env, STAGE: 'production' }), '/o/org-a/config-changes/propose', 'POST', { prompt: 'test' })).status).toBe(503)
})
