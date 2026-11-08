import { expect, type Page, type Response, type Request } from '@playwright/test'
const suppliedBodies = new WeakMap<Request, string>()
/** Match the exact JSON bytes a test supplies to route.fulfill before a reload. */
export function recordCanaryBody(request: Request, body: string) { suppliedBodies.set(request, body) }
const prepared = new WeakMap<Page, Promise<void>>()
/** Chromium otherwise discards response bodies across fast document navigations. */
export async function createCanaryOracle(...args: Parameters<typeof canaryOracle>) {
  const page = args[0]
  if (!prepared.has(page)) prepared.set(page, (async () => {
    const session = await page.context().newCDPSession(page)
    await session.send('Network.configureDurableMessages', { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 10_000_000 })
  })())
  await prepared.get(page)
  return canaryOracle(...args)
}
const oracles = new WeakMap<Page, Set<() => Promise<void>>>()
/** The final teardown boundary for all oracles attached to these pages. */
export async function drainCanaries(...pages: Page[]) {
  const results = await Promise.allSettled(pages.flatMap(page => [...(oracles.get(page) ?? [])].map(drain => drain())))
  for (const result of results) if (result.status === 'rejected') throw result.reason
}
/** Install BEFORE navigation. Drain body reads before checking the accessible page surface. */
export function canaryOracle(page: Page, tokens: readonly string[], options: { methods?: string[] } = {}) {
  const reads: Promise<void>[] = []; const leaks: string[] = []; const errors: unknown[] = []
  const onResponse = (response: Response) => {
    if (options.methods && !options.methods.includes(response.request().method())) return
    if (response.status() >= 300 && response.status() < 400) return // Chromium exposes no redirect body.
    if (!/json|text|javascript|xml/.test(response.headers()['content-type'] ?? '')) return
    const supplied = suppliedBodies.get(response.request())
    reads.push((supplied === undefined ? response.body() : Promise.resolve(Buffer.from(supplied))).then(body => {
      const surfaces = [body.toString()]
      // Compiler cursors are signed, base64url JSON, not encrypted. Inspect cursor keys too.
      try {
        const visit = (value: any) => {
          if (!value || typeof value !== 'object') return
          for (const [key, child] of Object.entries(value)) {
            if (key.endsWith('cursor') && typeof child === 'string') surfaces.push(Buffer.from(child.split('.')[0], 'base64url').toString())
            else visit(child)
          }
        }
        visit(JSON.parse(body.toString()))
      } catch {}
      if (tokens.some(token => surfaces.some(surface => surface.includes(token)))) leaks.push(new URL(response.url()).pathname)
    }).catch(error => { if (!/has been closed|Target closed/i.test(String(error))) errors.push(new Error(`${response.url()}: ${String(error)}`)) }))
  }
  page.on('response', onResponse)
  const check = async () => {
    // A response can arrive while an earlier body is draining. Consume each batch
    // before asserting, and store read failures instead of creating orphaned rejections.
    let consumed = 0
    while (consumed < reads.length) { const batch = reads.slice(consumed); consumed = reads.length; await Promise.all(batch) }
    if (errors.length) throw new AggregateError(errors, `canary response body read failed: ${errors.map(String).join('; ')}`)
    expect(leaks, 'canary appeared in a response body').toEqual([])
    if (page.isClosed()) return
    const url = page.url()
    let decodedUrl = url
    try { decodedUrl = decodeURIComponent(url) } catch {}
    for (const token of tokens) { expect(url, 'canary appeared in URL').not.toContain(token); expect(decodedUrl, 'canary appeared in decoded URL').not.toContain(token) }
    const body = await page.locator('body').textContent()
    for (const token of tokens) expect(body, 'canary appeared in body').not.toContain(token)
    const aria = await page.locator('body').ariaSnapshot()
    const dom = await page.content()
    for (const token of tokens) {
      expect(aria, 'canary appeared in aria snapshot').not.toContain(token)
      expect(dom, 'canary appeared in DOM').not.toContain(token)
    }
  }
  // The owning fixture stops collection before its final drain and page teardown.
  // Ordinary checks remain repeatable for tests that scan after every navigation.
  check.stop = () => { page.off('response', onResponse) }
  check.drain = async () => {
    check.stop()
    try { await check() } finally { oracles.get(page)?.delete(check.drain) }
  }
  if (!oracles.has(page)) oracles.set(page, new Set())
  oracles.get(page)!.add(check.drain)
  return check
}
