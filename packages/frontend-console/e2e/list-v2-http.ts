import { expect, type BrowserContext, type TestInfo } from '@playwright/test'

type Failure = { at: string; method: string; url: string; status: number; body: string }
const pending = new WeakMap<BrowserContext, Promise<Failure>[]>()

export function observePreview500(context: BrowserContext) {
  const failures: Promise<Failure>[] = []
  pending.set(context, failures)
  context.on('response', response => {
    if (response.status() !== 500) return
    const observed = { at: new Date().toISOString(), method: response.request().method(), url: response.url(), status: response.status() }
    failures.push(response.text().then(body => ({ ...observed, body }), error => ({ ...observed, body: `Unavailable: ${String(error)}` })))
  })
}

export async function assertNoPreview500(context: BrowserContext, info: TestInfo) {
  const failures = await Promise.all(pending.get(context) ?? [])
  if (failures.length) await info.attach('preview-http-500.json', { body: JSON.stringify(failures, null, 2), contentType: 'application/json' })
  expect(failures, 'Real preview HTTP 500: acceptance failed; see preview-http-500.json and retained runtime diagnostics').toEqual([])
}
