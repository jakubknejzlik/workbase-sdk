import { StrictMode, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MutationSession, blockMutationNavigation, getMutationSafetySnapshot, hasUnsavedMutation, subscribeMutationSafety, useMutationSession, useMutationState } from '../src'
const deferred = () => { let resolve!: () => void; let reject!: () => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error('failed')) }); return { promise, resolve, reject } }
function Owner({ name }: { name: string }) {
  const [value, setValue] = useState('Ada')
  useMutationState(value !== 'Ada', () => setValue('Ada'))
  return <input aria-label={name} value={value} onChange={event => setValue(event.target.value)} />
}
it('publishes read-only aggregate changes for registration, owners, reset, completion and cleanup', async () => {
  const snapshots: ReturnType<typeof getMutationSafetySnapshot>[] = []
  const unsubscribe = subscribeMutationSafety(() => snapshots.push(getMutationSafetySnapshot()))
  let one!: NonNullable<ReturnType<typeof useMutationSession>> & { reset: () => void }
  let two!: typeof one
  const view = render(<StrictMode><MutationSession close={() => {}} cancelLabel="Cancel">{session => { one = session; return <><Owner name="One" /><Owner name="Nested" /></> }}</MutationSession><MutationSession close={() => {}} cancelLabel="Cancel">{session => { two = session; return <Owner name="Two" /> }}</MutationSession></StrictMode>)
  expect(snapshots.length).toBeGreaterThan(0); expect(Object.isFrozen(getMutationSafetySnapshot())).toBe(true)
  fireEvent.change(screen.getByLabelText('One'), { target: { value: 'Grace' } }); fireEvent.change(screen.getByLabelText('Nested'), { target: { value: 'Lin' } }); fireEvent.change(screen.getByLabelText('Two'), { target: { value: 'Edsger' } })
  expect(getMutationSafetySnapshot()).toEqual({ dirty: true, submitting: false })
  act(() => one.reset()); expect(screen.getByLabelText('One')).toHaveProperty('value', 'Ada'); expect(screen.getByLabelText('Nested')).toHaveProperty('value', 'Ada')
  expect(getMutationSafetySnapshot().dirty).toBe(true); expect(screen.getByLabelText('Two')).toHaveProperty('value', 'Edsger')
  act(() => two.complete()); expect(getMutationSafetySnapshot()).toEqual({ dirty: false, submitting: false })
  expect(snapshots.some(snapshot => snapshot.dirty)).toBe(true)
  const beforeCleanup = snapshots.length; view.unmount(); expect(snapshots.length).toBeGreaterThan(beforeCleanup)
  expect(getMutationSafetySnapshot()).toEqual({ dirty: false, submitting: false }); unsubscribe()
})
it('completion preserves navigation semantics but safety waits through cleanup until settlement', async () => {
  const action = deferred(), close = vi.fn(), notify = vi.fn(), unsubscribe = subscribeMutationSafety(notify)
  let session!: NonNullable<ReturnType<typeof useMutationSession>>
  const view = render(<MutationSession close={close} cancelLabel="Cancel">{current => { session = current; return <Owner name="Draft" /> }}</MutationSession>)
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Grace' } })
  let running!: Promise<void>; act(() => { running = session.run(() => action.promise) })
  expect(getMutationSafetySnapshot()).toEqual({ dirty: true, submitting: true }); expect(await blockMutationNavigation()).toBe(true)
  act(() => session.complete()); expect(close).toHaveBeenCalledTimes(1); expect(hasUnsavedMutation()).toBe(false); expect(await blockMutationNavigation()).toBe(false)
  expect(getMutationSafetySnapshot()).toEqual({ dirty: false, submitting: true })
  view.unmount(); expect(getMutationSafetySnapshot().submitting).toBe(true)
  const beforeSettlement = notify.mock.calls.length
  await act(async () => { action.resolve(); await running })
  expect(notify.mock.calls.length).toBeGreaterThan(beforeSettlement); expect(getMutationSafetySnapshot()).toEqual({ dirty: false, submitting: false }); unsubscribe()
})
it('failed submission settles without clearing registered values or dirty state', async () => {
  const action = deferred(); let session!: NonNullable<ReturnType<typeof useMutationSession>>
  render(<MutationSession close={() => {}} cancelLabel="Cancel">{current => { session = current; return <Owner name="Draft" /> }}</MutationSession>)
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Grace' } })
  let running!: Promise<void>; act(() => { running = session.run(() => action.promise) })
  await act(async () => { action.reject(); await running })
  expect(getMutationSafetySnapshot()).toEqual({ dirty: true, submitting: false }); expect(screen.getByLabelText('Draft')).toHaveProperty('value', 'Grace')
})
