import { afterEach, expect, test } from 'vitest'
import { createServer as createHttpServer, type RequestListener } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const token = 'synthetic-stdio-ops-token'
const mailboxToken = 'synthetic-stdio-mailbox-token-at-least-32-characters'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function listen(handler: RequestListener) {
  const http = createHttpServer(handler)
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  cleanups.push(() => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())))
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`
}

test('workbase ops keeps credentials on separate HTTP destinations; mail URL appears only in the tool result with no stderr or log file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbase-ops-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const requests: { destination: string; path: string; method: string; headers: any; body: unknown }[] = []
  const data = { id: 'first-org', name: 'First org', role: 'owner', replayed: false }
  const link = 'http://localhost/auth/magic-link/verify?token=synthetic-mail-link'
  const mailbox = { messages: [{ id: 'mail', recipient: 'first@example.test', subject: 'Workbase sign-in', body: link, created_at: '2026-11-14T00:00:00Z', expires_at: null }] }
  const handler = (destination: string): RequestListener => async (req, res) => {
    let text = ''
    for await (const part of req) text += part
    requests.push({ destination, path: req.url!, method: req.method!, headers: req.headers, body: text ? JSON.parse(text) : null })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(destination === 'app' ? data : mailbox))
  }
  const baseUrl = await listen(handler('app'))
  const mailboxUrl = await listen(handler('mailbox'))
  const transport = new StdioClientTransport({ command: 'bun', args: ['--no-install', resolve('packages/mcp/src/bin.ts'), 'ops'], cwd: root,
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      TMPDIR: root, WORKBASE_MCP_STATE_ROOT: root, WORKBASE_BASE_URL: baseUrl, WORKBASE_OPS_TOKEN: token,
      WORKBASE_DEV_MAILBOX_URL: mailboxUrl, WORKBASE_DEV_MAILBOX_TOKEN: mailboxToken }, stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', part => { stderr += part })
  const client = new Client({ name: 'ops-stdio', version: '1' })
  cleanups.push(() => transport.close(), () => client.close())
  await client.connect(transport)
  expect(client.getServerVersion()?.name).toBe('workbase-ops')
  expect(JSON.stringify(await client.listTools())).not.toContain(link)
  expect((await client.callTool({ name: 'provision_organization', arguments: { name: 'First org', ownerEmail: 'first@example.test' } })).structuredContent)
    .toEqual({ ok: true, data })
  const result = await client.callTool({ name: 'read_dev_mail', arguments: { recipient: 'first@example.test' } })
  expect(result.structuredContent).toEqual({ ok: true, data: mailbox })
  expect(JSON.stringify(result)).toContain(link)
  expect(requests.map(req => [req.destination, req.method, req.path, req.body])).toEqual([
    ['app', 'POST', '/internal/organizations', { name: 'First org', ownerEmail: 'first@example.test' }],
    ['mailbox', 'GET', '/messages?recipient=first%40example.test&limit=20', null],
  ])
  expect(requests[0].headers['x-internal-token']).toBe(token)
  expect(requests[0].headers.authorization).toBeUndefined()
  expect(requests[1].headers.authorization).toBe(`Bearer ${mailboxToken}`)
  expect(requests[1].headers['x-internal-token']).toBeUndefined()
  expect(requests.every(req => !req.headers['x-organization-id'] && !req.headers.origin)).toBe(true)
  await client.close()
  expect(stderr).toBe('')
  expect(await readdir(root)).toEqual([])
})

test('ops startup failures are silent with no stdout or stderr, including unsafe mailbox URLs and CLI authority', async () => {
  for (const [args, extra] of [
    [[], { WORKBASE_OPS_TOKEN: '' }],
    [[], { WORKBASE_BASE_URL: 'http://example.test' }],
    [[], { WORKBASE_DEV_MAILBOX_URL: 'http://example.test', WORKBASE_DEV_MAILBOX_TOKEN: mailboxToken }],
    [['--token', token], {}],
  ] as const) {
    const child = spawn('bun', ['--no-install', resolve('packages/mcp/src/bin.ts'), 'ops', ...args], {
      env: { ...process.env, WORKBASE_BASE_URL: 'http://localhost:8997', WORKBASE_OPS_TOKEN: token, WORKBASE_DEV_MAILBOX_URL: '', WORKBASE_DEV_MAILBOX_TOKEN: '', ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    const [status] = await once(child, 'close')
    expect(status).toBe(1); expect(stdout).toBe(''); expect(stderr).toBe('')
  }
})
