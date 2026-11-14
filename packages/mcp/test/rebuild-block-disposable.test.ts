import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { applyDisposable } from '../src/disposable'
import { rebuildFixture, columnsBlock, genericBlock } from './fixtures/rebuild-block'

const processFailure = vi.hoisted(() => ({ output: '' }))
vi.mock('node:child_process', () => ({ spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  setImmediate(() => { child.stderr.write(processFailure.output); child.emit('close', 1) })
  return child
} }))
afterEach(() => vi.restoreAllMocks())
it.each([
  ['CHECK constraint failed: rebuild_requires_review_records_columns: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)', columnsBlock],
  ['CHECK constraint failed: rebuild_requires_review_secret_customer_columns: SQLITE_CONSTRAINT', genericBlock],
  ['rebuild_requires_review_records_columns INJECTED_PRIVATE_TEXT', genericBlock],
  ['CHECK constraint failed: rebuild_requires_review_records_columns INJECTED_PRIVATE_TEXT', genericBlock],
  ['CHECK constraint failed: rebuild_requires_review', genericBlock],
])('Wrangler classifies constraint output safely: %s', async (output, message) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  processFailure.output = output
  const bundle = rebuildFixture(false)
  expect(await applyDisposable(bundle, { target: bundle.config, indexes: [], sql: '' }, [], false)).toEqual({ verified: false, diffs: [{ code: 'migration_blocked', message }] })
})
it('an interrupted Wrangler guard failure keeps cancellation precedence', async () => {
  processFailure.output = 'CHECK constraint failed: rebuild_requires_review_records_columns'
  const bundle = rebuildFixture(false)
  expect(await applyDisposable(bundle, { target: bundle.config, indexes: [], sql: '' }, [], false, AbortSignal.abort())).toEqual({ verified: false, diffs: [{ code: 'disposable_apply_failed', message: 'Local migration cancelled or exceeded 90 seconds' }] })
})
