import { z } from 'zod'
import type { Configuration } from './config.ts'
import { FeedbackError } from './schemas.ts'
import { assertPublic } from './safety.ts'

const user = z.object({ login: z.string().max(100) })
const issue = z.object({ number: z.number().int().positive(), state: z.enum(['open', 'closed']), user, body: z.string().max(1000000).nullable(), labels: z.array(z.union([z.string(), z.object({ name: z.string().max(200) })])).max(100), pull_request: z.unknown().optional() })
const comment = z.object({ id: z.number().int().positive(), user, body: z.string().max(1000000), created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }) })
export type Issue = z.infer<typeof issue>
export type Comment = z.infer<typeof comment>

async function json(request: typeof fetch, token: string, url: string, method = 'GET', body?: unknown) {
  try {
    const response = await request(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw new Error()
    // Bounded streaming read, including when Content-Length is missing/untrusted.
    const reader = response.body?.getReader(); if (!reader) throw new Error()
    let size = 0; const parts: Uint8Array[] = []
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 4000000) throw new Error(); parts.push(value) }
    } finally { await reader.cancel().catch(() => {}) }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
  } catch { throw new FeedbackError(method === 'POST' ? 'delivery_unknown' : 'github_unavailable', 503) }
}
/** Separate identity bootstrap; the issue adapter has no arbitrary endpoint API. */
export async function postingIdentity(request: typeof fetch, token: string) {
  try {
    const login = user.parse(await json(request, token, 'https://api.github.com/user')).login
    if (login.includes(token) || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\[bot\])?$/.test(login)) throw new Error()
    return login.toLowerCase()
  }
  catch { throw new FeedbackError('github_unavailable', 503) }
}

/** Fixed repository and endpoint allowlist. No edit/delete/code/PR/action capabilities. */
export class FeedbackGitHub {
  readonly #base: string
  constructor(private config: Configuration, private token: string, private request: typeof fetch) {
    this.#base = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/issues`
  }
  async #read<T>(url: string, schema: z.ZodType<T>) {
    try { return schema.parse(await json(this.request, this.token, url)) }
    catch { throw new FeedbackError('github_unavailable', 503) }
  }
  async #pages<T>(path: string, schema: z.ZodType<T>, query = ''): Promise<T[]> {
    const all: T[] = []
    for (let page = 1; page <= 20; page++) {
      // Never follow Link URLs. Every page is constructed under the fixed repo.
      const items = await this.#read(`${this.#base}${path}?per_page=100&page=${page}${query}`, z.array(schema).max(100))
      all.push(...items)
      if (items.length < 100) return all
    }
    throw new FeedbackError('pagination_limit', 409)
  }
  listIssues() { return this.#pages('', issue, '&state=all&sort=created&direction=asc') }
  readIssue(number: number) { return this.#read(`${this.#base}/${this.#number(number)}`, issue) }
  comments(number: number) { return this.#pages(`/${this.#number(number)}/comments`, comment) }
  #number(number: number) { if (!Number.isSafeInteger(number) || number < 1) throw new FeedbackError('invalid_issue_number'); return number }
  async createIssue(title: string, body: string) {
    const payload = { title, body, labels: [this.config.label] }; assertPublic(payload, this.token)
    try { return issue.parse(await json(this.request, this.token, this.#base, 'POST', payload)) }
    catch { throw new FeedbackError('delivery_unknown', 503) }
  }
  // Only the service supplies a server-rendered event, never a caller comment body.
  async postEvent(number: number, body: string) {
    assertPublic(body, this.token)
    try { return comment.parse(await json(this.request, this.token, `${this.#base}/${this.#number(number)}/comments`, 'POST', { body })) }
    catch { throw new FeedbackError('delivery_unknown', 503) }
  }
}
