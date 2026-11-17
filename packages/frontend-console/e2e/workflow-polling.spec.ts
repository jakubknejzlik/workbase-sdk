import { test as base, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupWorkflowFixture, origin } from './runtime/workflow-setup'
import { causeChain } from './runtime/workflow-diagnostics'

const test = base.extend<{ worker: Awaited<ReturnType<typeof setupWorkflowFixture>> }>({
  worker: async ({}, use, testInfo) => {
    const fixture = await setupWorkflowFixture()
    try { await use(fixture) }
    finally {
      await fixture.stop()
      const log = fixture.logs()
      await testInfo.attach('Worker diagnostics', { body: JSON.stringify({ persistenceDir: fixture.persist, workerLog: log.slice(-16000) }, null, 2), contentType: 'application/json' })
      expect(/SQLITE_BUSY|database is locked|database table is locked/i.test(log), `Worker-owned BUSY; stop and inspect ${fixture.directory}`).toBe(false)
    }
  },
})

test('C5: running render barrier → completed stops polling; navigation unmounts an active poller', async ({ page, worker: fixture }, testInfo) => {
  // Node fetch keeps fixture credentials out of Playwright API call/network traces.
  const controlRequest = (data: unknown, authenticated = true) => fetch(`${origin}/__test/c5`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${fixture.token}` } : {}) },
    body: JSON.stringify(data),
  })
  const events: unknown[] = []
  const checkpoints: { phase: string; workflowGets: number; quietWindowMs: number }[] = []
  let phase = 'browser-workflow-GET'
  const workflowGets: string[] = []
  const pending = new Set<Promise<void>>()
  const httpFailures: unknown[] = []
  page.on('request', req => {
    if (req.method() === 'GET' && new URL(req.url()).pathname.startsWith('/workflows')) workflowGets.push(req.url())
    if (req.method() === 'POST' && new URL(req.url()).pathname.includes('/workflows')) httpFailures.push({ operation: 'unexpected-workflow-execution', url: req.url() })
  })
  page.on('requestfailed', req => {
    const workflow = new URL(req.url()).pathname.startsWith('/workflows')
    const event = { operation: workflow ? 'browser-workflow-GET' : 'browser-other-request', url: req.url(), status: null, cause: req.failure() }
    // Document navigation can cancel the shell's independent /me poll. Preserve
    // it as evidence; every failed workflow request remains an assertion failure.
    events.push(event)
    if (workflow) httpFailures.push(event)
  })
  page.on('console', message => { if (message.type() === 'error') httpFailures.push({ operation: 'browser-console', message: message.text() }) })
  page.on('pageerror', error => httpFailures.push({ operation: 'browser-render', causes: causeChain(error) }))
  page.on('response', response => {
    if (!new URL(response.url()).pathname.startsWith('/workflows')) return
    const task = (async () => {
      const event = { operation: 'browser-workflow-GET', url: response.url(), status: response.status(), body: await response.text() }
      events.push(event)
      if (!response.ok()) httpFailures.push(event)
    })()
    pending.add(task); void task.catch(error => httpFailures.push({ operation: 'browser-response-body', causes: causeChain(error) })).finally(() => pending.delete(task))
  })
  const control = async (action: string, id: string, token?: string) => {
    phase = 'fixture-mutation/barrier'
    const response = await controlRequest({ action, id, token })
    const event = { operation: phase, action, id, status: response.status, body: await response.text() }
    events.push(event)
    expect(response.ok, JSON.stringify(event)).toBe(true)
    phase = 'browser-workflow-GET'
  }
  const renderRunning = async (id: string) => {
    const read = page.waitForResponse(response => new URL(response.url()).pathname === `/workflows/${id}` && response.request().method() === 'GET', { timeout: 10_000 })
    await page.goto(`/o/org-a/settings/workflows/${id}`)
    const response = await read
    expect(response.status()).toBe(200)
    expect((await response.json()).status).toBe('running')
    await expect(page.getByTestId('run-status')).toHaveText('Running')
    // The acknowledgement is sent only after the nonterminal response rendered.
    await control('rendered', id, response.headers()['x-c5-read'])
  }
  try {
    // Verify the fixture guard and authentication before allowing the transition.
    expect((await controlRequest({ action: 'complete', id: 'c5-terminal' }, false)).status).toBe(401)
    const premature = await controlRequest({ action: 'complete', id: 'c5-terminal' })
    expect(premature.status).toBe(409)
    await renderRunning('c5-terminal')
    await control('complete', 'c5-terminal')
    await expect(page.getByTestId('run-status')).toHaveText('Completed', { timeout: 10_000 })
    const terminalCount = workflowGets.length
    // Real time, more than two production polling intervals; no cadence override.
    await page.waitForTimeout(6500)
    expect(workflowGets).toHaveLength(terminalCount)
    checkpoints.push({ phase: 'terminal', workflowGets: terminalCount, quietWindowMs: 6500 })

    await renderRunning('c5-unmount')
    const polled = await page.waitForResponse(response => new URL(response.url()).pathname === '/workflows/c5-unmount' && response.request().method() === 'GET', { timeout: 6000 })
    expect(polled.status()).toBe(200)
    expect((await polled.json()).status).toBe('running')
    await expect(page.getByTestId('run-status')).toHaveText('Running')
    // A client-side link unmounts WorkflowDetail without destroying its document.
    await page.getByRole('link', { name: 'Back to list', exact: true }).click()
    await expect(page.getByTestId('run-status')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1, name: 'Workflow runs' })).toBeVisible()
    await Promise.allSettled([...pending])
    const unmountedCount = workflowGets.length
    await page.waitForTimeout(6500)
    expect(workflowGets).toHaveLength(unmountedCount)
    checkpoints.push({ phase: 'unmounted', workflowGets: unmountedCount, quietWindowMs: 6500 })
    expect(httpFailures).toEqual([])
  } catch (error) {
    const diagnostics = { operation: phase, causes: causeChain(error), httpFailures, events, checkpoints, persistenceDir: fixture.persist, workerLog: fixture.logs().slice(-16000), workflowExecution: 'not invoked (synthetic rows)' }
    writeFileSync(resolve(fixture.directory, 'failure.json'), JSON.stringify(diagnostics, null, 2))
    await testInfo.attach('C5 failure diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' })
    throw error
  } finally {
    await Promise.allSettled([...pending])
    const log = fixture.logs()
    const summary = { repeat: testInfo.repeatEachIndex, retry: testInfo.retry, events, httpFailures, checkpoints, persistenceDir: fixture.persist, busy: /SQLITE_BUSY|database is locked|database table is locked/i.test(log), workflowExecution: 'not invoked (synthetic rows)' }
    writeFileSync(resolve(fixture.directory, 'summary.json'), JSON.stringify(summary, null, 2))
    await testInfo.attach('C5 run diagnostics', { body: JSON.stringify({ ...summary, workerLog: log.slice(-16000) }, null, 2), contentType: 'application/json' })
  }
})
