import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { defineInstance } from '@workbasehq/core/config'
import { applyDisposable } from '../src/disposable'

const processFailure = vi.hoisted(() => ({ stdout: '', stderr: '', kind: 'exit' }))
vi.mock('node:child_process', () => ({ spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  setImmediate(() => {
    child.stdout.write(processFailure.stdout); child.stderr.write(processFailure.stderr)
    if (processFailure.kind === 'error') child.emit('error', new Error(processFailure.stderr))
    else child.emit('close', 1)
  })
  return child
} }))
afterEach(() => { vi.restoreAllMocks(); processFailure.kind = 'exit' })
async function apply(signal?: AbortSignal) {
  const current = defineInstance({ id: 'error_fixture', revision: 1, roles: ['owner'], entities: {}, permissions: {} })
  return applyDisposable({ config: current, migrations: [], indexes: [], fingerprint: '', guards: {} }, { target: current, indexes: [], sql: '' }, [], false, signal)
}
it('verify1: embedded rebuild_requires_review_synthetic_private_text_columns stderr stays private', async () => {
  processFailure.stderr = 'prefix rebuild_requires_review_synthetic_private_text_columns suffix'
  expect(await apply()).toEqual({ verified: false, diffs: [{ code: 'disposable_apply_failed', message: 'Wrangler rejected the disposable migration' }] })
})
it('verify1: six-character payload windows stay private across process error paths', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (let seed = 0; seed < 8; seed++) {
    const payload = 'z' + createHash('sha256').update(`verify1:process:${seed}`).digest('hex')
    for (const kind of ['exit', 'error', 'abort']) for (const channel of ['stdout', 'stderr'] as const) for (const wrapper of [payload, `rebuild_requires_review_${payload}_columns`, `{"kind":"rebuild_requires_review_${payload}_columns"}`]) {
      processFailure.kind = kind; processFailure.stdout = ''; processFailure.stderr = ''; processFailure[channel] = wrapper
      const result = await apply(kind === 'abort' ? AbortSignal.abort() : undefined)
      expect(result.verified).toBe(false)
      const publicValue = JSON.stringify(result)
      for (let i = 0; i <= payload.length - 6; i++) expect(publicValue).not.toContain(payload.slice(i, i + 6))
    }
  }
})
