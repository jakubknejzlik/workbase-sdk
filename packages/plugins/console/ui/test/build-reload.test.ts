import { expect, test, vi } from 'vitest'
import { watchBuild } from '../src/build-reload'
const bundle = 'a'.repeat(40), server = 'b'.repeat(40)
function setup(sha = server, dirty = false, storage = new Map<string, string>()) {
  const listeners = new Set<() => void>(), reload = vi.fn()
  const fetch = vi.fn(async () => Response.json({ sha }))
  const options = { sha: bundle, fetch, dirty: () => dirty, storage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } },
    document: { visibilityState: 'visible', addEventListener: (_event: string, listener: () => void) => { listeners.add(listener) }, removeEventListener: (_event: string, listener: () => void) => { listeners.delete(listener) } }, reload }
  return { options, listeners, reload, storage, fetch, setDirty: (value: boolean) => { dirty = value } }
}
const settled = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
test('persistent mismatch reloads exactly once across remounts and repeated visibility', async () => {
  const f = setup(), first = watchBuild(f.options); await settled(); expect(f.reload).toHaveBeenCalledTimes(1)
  for (const listener of f.listeners) listener(); await settled(); expect(f.reload).toHaveBeenCalledTimes(1)
  first.stop(); const second = watchBuild(f.options); await settled(); expect(f.reload).toHaveBeenCalledTimes(1)
  expect([...f.storage.keys()]).toEqual(['workbase.reload.' + server]); second.stop(); expect(f.listeners.size).toBe(0)
})
test('dirty form defers reload until clean; independent next SHA gets its own latch', async () => {
  const f = setup(server, true), watch = watchBuild(f.options); await settled(); expect(f.reload).not.toHaveBeenCalled(); expect(f.storage.size).toBe(0)
  f.setDirty(false); watch.flush(); watch.flush(); expect(f.reload).toHaveBeenCalledTimes(1); watch.stop()
  f.fetch.mockResolvedValueOnce(Response.json({ sha: 'c'.repeat(40) })); const next = watchBuild(f.options); await settled(); expect(f.reload).toHaveBeenCalledTimes(2); next.stop()
})
test.each(['unbuilt', '', 'abc', bundle])('server SHA %s never reloads', async sha => {
  const f = setup(sha), watch = watchBuild(f.options); await settled(); expect(f.reload).not.toHaveBeenCalled(); watch.stop()
})
test('an unbuilt bundle, failed metadata, or disabled storage cannot loop', async () => {
  const f = setup(), dev = watchBuild({ ...f.options, sha: 'unbuilt' }); await settled(); dev.stop(); expect(f.reload).not.toHaveBeenCalled()
  const denied = watchBuild({ ...f.options, storage: { getItem: () => { throw new Error('disabled') }, setItem: () => {} } }); await settled(); denied.stop(); expect(f.reload).not.toHaveBeenCalled()
  f.fetch.mockRejectedValueOnce(new TypeError('offline')); const offline = watchBuild(f.options); await settled(); offline.stop(); expect(f.reload).not.toHaveBeenCalled()
})
test('late metadata from a stopped watcher cannot reload', async () => {
  const f = setup(); let finish!: (response: Response) => void
  f.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const watch = watchBuild(f.options); watch.stop(); finish(Response.json({ sha: server })); await settled(); expect(f.reload).not.toHaveBeenCalled()
})
