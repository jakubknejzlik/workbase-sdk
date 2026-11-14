import { equalHash, sha256 } from './crypto'

interface DevMailboxEnv {
  DB: D1Database
  STAGE?: string
  DEV_MAILBOX_TOKEN?: string
}

export default {
  /** Separate operator-only Worker entry. Never import this from the application Worker. */
  async fetch(request: Request, env: DevMailboxEnv): Promise<Response> {
    const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } })
    // Defense in depth for hand-deployed sidecars; the provisioner also gates construction.
    if (env.STAGE !== 'dev' && env.STAGE !== 'test') return respond({ error: 'not_found' }, 404)
    if (!env.DEV_MAILBOX_TOKEN || !/^[\x21-\x7e]{32,256}$/.test(env.DEV_MAILBOX_TOKEN)) return respond({ error: 'dev_mailbox_not_configured' }, 503)
    const authorization = request.headers.get('Authorization') ?? ''
    if (request.headers.has('Origin') || !authorization.startsWith('Bearer ') || authorization.length > 263
      || !equalHash(await sha256(authorization.slice(7)), await sha256(env.DEV_MAILBOX_TOKEN))) return respond({ error: 'forbidden' }, 403)
    const url = new URL(request.url)
    if (url.pathname !== '/messages') return respond({ error: 'not_found' }, 404)
    if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405)
    const recipient = url.searchParams.get('recipient') ?? ''
    const limit = url.searchParams.get('limit') ?? '20'
    if (url.searchParams.getAll('recipient').length !== 1 || recipient.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient)
      || url.searchParams.getAll('limit').length > 1 || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50
      || [...url.searchParams.keys()].some(key => key !== 'recipient' && key !== 'limit')) return respond({ error: 'invalid_query' }, 400)
    try {
      const { results } = await env.DB.prepare(`SELECT id,recipient,subject,body,created_at,expires_at FROM email_outbox
        WHERE recipient=? ORDER BY created_at DESC,rowid DESC LIMIT ?`).bind(recipient, Number(limit)).all()
      return respond({ messages: results })
    } catch { return respond({ error: 'dev_mailbox_unavailable' }, 503) }
  },
}
