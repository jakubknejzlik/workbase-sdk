import { beforeEach, expect, it } from 'vitest'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '@workbasehq/core/app'
import { request, runtime, setup } from '@workbasehq/test-support/helpers'
import { consoleRegistry } from '../src/index'
import type { VersionHistory } from '../../../core/src/migrations/version-contract'

beforeEach(async () => { await setup() })
it('SR-84 console owns Versions in Operations and serves private scoped read-only plans', async () => {
  const app = createApp(sample, runtime())
  const registry = await (await request(app, '/o/org-a/console-registry')).json() as ReturnType<typeof consoleRegistry>
  expect(registry.navigation.find(item => item.page === 'console.versions')).toMatchObject({ placement: 'settings', group: { id: 'operations' } })
  const response = await request(app, '/o/org-a/config-versions')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const history = await response.json() as VersionHistory
  expect(history.instance).toBe('sample')
  expect(history.versions.map(v => v.revision)).toEqual([1, 2, 3])
  expect(history.versions[1].changes.some(c => c.path === 'entities.jobs.fields.priority' && c.change === 'added')).toBe(true)
  expect(history.versions[0].rollback.blocked).toContain('Destructive operations require --allow-destructive')
  expect(history.versions[0].rollback.sql).not.toContain('DROP TABLE')
  expect((await request(app, '/o/org-a/config-versions', 'POST')).status).toBe(404)
})
it('SR-84 rechecks grants and tenant scope, including direct reads and removed console', async () => {
  const app = createApp(sample, runtime())
  expect((await request(app, '/o/org-a/config-versions', 'GET', undefined, 'viewer-a')).status).toBe(403)
  expect((await request(app, '/o/org-b/config-versions', 'GET', undefined, 'owner-a')).status).toBe(403)
  expect((await app.request('/o/org-a/config-versions')).status).toBe(401)
  const viewer = await (await request(app, '/o/org-a/console-registry', 'GET', undefined, 'viewer-a')).json() as ReturnType<typeof consoleRegistry>
  expect(viewer.pages.some(page => page.id === 'console.versions')).toBe(false)
  const headless = createApp({ ...sample, plugins: sample.plugins!.filter(p => !['console', 'audit'].includes(p.name)) }, runtime())
  expect((await request(headless, '/o/org-a/config-versions')).status).toBe(404)
})
