import { render, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWorkflowPolling } from '../../frontend-console/src/api/workflows'
function Probe({ status, refresh }: { status: string; refresh: () => unknown }) { useWorkflowPolling(status, refresh); return null }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
it('C5 mounted polling hook stops for terminal rerenders and unmount', () => {
  vi.useFakeTimers(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const refresh = vi.fn(); const view = render(<Probe status="running" refresh={refresh} />)
  act(() => vi.advanceTimersByTime(3000)); expect(refresh).toHaveBeenCalledTimes(1)
  view.rerender(<Probe status="error" refresh={refresh} />); act(() => vi.advanceTimersByTime(9000)); expect(refresh).toHaveBeenCalledTimes(1)
  view.rerender(<Probe status="running" refresh={refresh} />); view.unmount(); act(() => vi.advanceTimersByTime(9000)); expect(refresh).toHaveBeenCalledTimes(1)
})
it('C5 mounted polling hook pauses hidden tabs and removes visibility listener on unmount', () => {
  vi.useFakeTimers(); const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const refresh = vi.fn(); const view = render(<Probe status="pending" refresh={refresh} />)
  act(() => vi.advanceTimersByTime(6000)); expect(refresh).not.toHaveBeenCalled()
  visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(refresh).toHaveBeenCalledOnce()
  visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange'))); act(() => vi.advanceTimersByTime(6000)); expect(refresh).toHaveBeenCalledOnce()
  view.unmount(); visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(refresh).toHaveBeenCalledOnce()
})
it('C5 polling uses the latest callback without restarting the three-second cadence', () => {
  vi.useFakeTimers(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const first = vi.fn(); const next = vi.fn(); const view = render(<Probe status="running" refresh={first} />)
  act(() => vi.advanceTimersByTime(2000)); view.rerender(<Probe status="running" refresh={next} />)
  act(() => vi.advanceTimersByTime(1000)); expect(next).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled(); view.unmount()
})
