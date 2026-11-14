import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { defineInstance } from '@workbasehq/core/config'
import { applyDisposable } from '../src/disposable'
vi.mock('node:child_process', () => ({ spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  setImmediate(() => { child.stderr.write('FAKE_STDERR_SECRET'); child.emit('close', 1) })
  return child
} }))
it('keeps raw Wrangler stderr out of disposable responses', async () => {
  const current = defineInstance({ id: 'error_fixture', revision: 1, roles: ['owner'], entities: {}, permissions: {} })
  const result = await applyDisposable({ config: current, migrations: [], indexes: [], fingerprint: '', guards: {} }, { target: current, indexes: [], sql: '' }, [], false)
  expect(result.verified).toBe(false)
  expect(JSON.stringify(result)).not.toContain('FAKE_STDERR_SECRET')
  expect(result.diffs).toEqual([{ code: 'disposable_apply_failed', message: 'Wrangler rejected the disposable migration' }])
})
