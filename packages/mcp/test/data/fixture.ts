import { sample } from '../fixtures/model'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { KernelRegistry } from '../../../core/src/kernel/registry'
import '../../../../scripts/local-network-only.cjs'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { resolve, join } from 'node:path'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { getPlatformProxy } from 'wrangler'
import { withD1Retry } from './d1-retry.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const run = promisify(execFile)
export const stateRoot = process.env.WORKBASE_DATA_MCP_STATE ?? '/tmp/codex/data-mcp-state'
export async function startFixture() {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(join(stateRoot, 'http-'))
  const guard = resolve('scripts/local-network-only.cjs')
  if (!process.env.NODE_OPTIONS?.includes(guard)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(guard)}`.trim()
  Object.assign(process.env, { TMPDIR: stateRoot, WRANGLER_REGISTRY_PATH: join(scratch, 'registry'), WRANGLER_CACHE_DIR: join(scratch, 'cache'), WRANGLER_LOG_PATH: join(scratch, 'wrangler.log'), CLOUDFLARE_CF_FETCH_ENABLED: 'false', CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', DO_NOT_TRACK: '1', WRANGLER_HIDE_BANNER: 'true' })
  const reservation = createServer()
  reservation.listen(Number(process.env.WORKBASE_DATA_MCP_PORT ?? 0), '127.0.0.1')
  await once(reservation, 'listening')
  const port = (reservation.address() as import('node:net').AddressInfo).port
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const base = `http://127.0.0.1:${port}`, org = 'data-mcp-org', otherOrg = 'data-mcp-other'
  const internal = randomBytes(32).toString('hex'), authSecret = randomBytes(32).toString('hex')
  const secrets = new Set([internal, authSecret, internal.slice(0, 37), authSecret.slice(0, 37)])
  const sanitize = (text: string) => {
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
    return text.replace(/([?&]token=)[^&\s]+/g, '$1[redacted]').replace(/wb_[a-f0-9]+/g, '[redacted]')
  }
  const persist = join(scratch, 'state'), suffix = randomUUID().slice(0, 8), configs: Record<string, string> = {}
  const clients: Client[] = [], transports: StdioClientTransport[] = []
  let worker: ChildProcess | undefined, proxy: Awaited<ReturnType<typeof getPlatformProxy>> | undefined
  const log = createWriteStream(join(scratch, 'worker.log'), { mode: 0o600 })
  const close = async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    if (worker?.pid) {
      const exited = worker.exitCode !== null || worker.signalCode !== null ? Promise.resolve() : once(worker, 'exit')
      try { process.kill(-worker.pid, 'SIGTERM') } catch { /* already exited */ }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000) })]); clearTimeout(timer)
      try { process.kill(-worker.pid, 'SIGKILL') } catch { /* already exited */ }
    }
    await proxy?.dispose(); log.end()
  }
  try {
    assert.equal(await fetch(`${base}/health`).then(() => true, () => false), false, `Reserved port ${port} occupied`)
    const directory = resolve('packages/mcp/test/fixtures')
    const migrationDir = join(scratch, 'migrations')
    await mkdir(migrationDir)
    await writeFile(join(migrationDir, '0001_initial.sql'), initialSchema(sample))
    const source = {
      name: `data-mcp-app-${suffix}`, main: join(directory, 'worker.ts'),
      compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'],
      dev: { ip: '127.0.0.1', port, inspector_port: 0 },
      vars: { INTERNAL_TOKEN: internal, AUTH_BASE_URL: base, BETTER_AUTH_SECRET: authSecret },
      d1_databases: [{ binding: 'DB', database_name: 'data-mcp', database_id: '00000000-0000-0000-0000-000000000001', migrations_dir: migrationDir }],
      kv_namespaces: [{ binding: 'AUDIT_KV', id: '00000000000000000000000000000001' }],
      queues: { producers: [{ binding: 'EVENTS_QUEUE', queue: `data-mcp-events-${suffix}` }] },
    }
    configs.app = join(scratch, 'app.json')
    await writeFile(configs.app, JSON.stringify(source), { mode: 0o600 })
    const wrangler = resolve('node_modules/wrangler/bin/wrangler.js')
    for (const [key, bindings] of [['app', ['DB']]] as const) {
      for (const binding of bindings) await run(process.execPath, [wrangler, 'd1', 'migrations', 'apply', binding, '--local', '--config', configs[key], '--persist-to', persist], { cwd: scratch, env: process.env })
    }
    const seed = JSON.parse(await readFile(configs.app, 'utf8'))
    const seedFile = join(scratch, 'seed.json'); await writeFile(seedFile, JSON.stringify(seed), { mode: 0o600 })
    proxy = await getPlatformProxy({ configPath: seedFile, remoteBindings: false, persist: { path: `${persist}/v3` } })
    const db = withD1Retry((proxy.env as { DB: D1Database }).DB), now = new Date().toISOString(), user = 'data-mcp-owner', email = `${user}@example.test`
    await new KernelRegistry(sample).applyMigrations(db as unknown as globalThis.D1Database)
    await db.batch([
      db.prepare('INSERT INTO organizations VALUES (?,?),(?,?)').bind(org, 'Data MCP', otherOrg, 'Foreign organization'),
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').bind(user, email, 'unused', 'unused', now),
      db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(user, user, email, now, now),
      db.prepare("INSERT INTO memberships VALUES (?,?,'owner')").bind(user, org),
      db.prepare('INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind('seed-client', org, 'Seed client', now, now),
      db.prepare('INSERT INTO jobs (id,organization_id,title,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('seed-job', org, 'Seed job', 'seed-client', now, now),
      db.prepare('INSERT INTO slots (id,organization_id,job_id,starts_at,capacity,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind('seed-slot', org, 'seed-job', now, 10, now, now),
    ])
    worker = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', configs.app, '--port', String(port), '--inspector-port', '0', '--persist-to', persist], { cwd: scratch, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let spawnError: unknown
    worker.on('error', error => { spawnError = error })
    for (const stream of [worker.stdout, worker.stderr]) stream!.on('data', chunk => log.write(sanitize(chunk.toString())))
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      if (spawnError) throw new Error('Worker failed to start')
      if (worker.exitCode !== null || worker.signalCode !== null) throw new Error('Worker exited before readiness')
      if (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, 'Worker readiness deadline')
    // Use the same real Better Auth mail-sink/session journey as the other HTTP harnesses.
    const { magicSession } = await import('../../../../scripts/identity-session.mjs')
    const session: string = await magicSession(base, db, email)
    secrets.add(session)
    let responses = 0, mcpCalls = 0
    const call = async (path: string, method = 'GET', body?: unknown, token = session, selectedOrg = org, extra: Record<string, string> = {}) => {
      responses++
      return fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': selectedOrg, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    }
    const json = async (response: Response, status = 200) => { assert.equal(response.status, status, 'Expected API status'); return response.json() as Promise<any> }
    const issue = async (role: string, operations?: string[]) => {
      const result = await json(await call(`/orgs/${org}/tokens`, 'POST', { name: `MCP ${role}`, role, ...(operations ? { operations } : {}) }), 201)
      secrets.add(result.token); return result as { id: string; token: string }
    }
    const dispatcher = await issue('dispatcher'), viewer = await issue('viewer'), restricted = await issue('dispatcher', ['clients.read'])
    const revoked = await issue('dispatcher'), expired = await issue('dispatcher'), owner = await issue('owner', ['audit.read'])
    assert.equal((await call(`/orgs/${org}/tokens/${revoked.id}`, 'DELETE')).status, 204)
    await db.prepare('UPDATE access_tokens SET expires_at=? WHERE id=?').bind('2000-01-01T00:00:00.000Z', expired.id).run()
    const connect = async (token = dispatcher.token, selectedOrg = org, readOnly = false) => {
      const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs'), resolve('packages/mcp/src/data/stdio.ts')], cwd: resolve('.'), env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), WORKBASE_BASE_URL: base, WORKBASE_TOKEN: token, WORKBASE_ORG_ID: selectedOrg, WORKBASE_READ_ONLY: String(readOnly) }, stderr: 'pipe' })
      transports.push(transport)
      transport.stderr?.on('data', chunk => log.write(sanitize(chunk.toString())))
      const client = new Client({ name: 'data-mcp-http-test', version: '1' }); clients.push(client)
      const callTool = client.callTool.bind(client)
      client.callTool = (...args: Parameters<typeof client.callTool>) => { mcpCalls++; return callTool(...args) }
      await client.connect(transport); return client
    }
    const tool = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args })
      const body = result.structuredContent as Record<string, any>
      assert.equal(result.isError, name === 'query' ? typeof body.error === 'string' : body.ok === false); assert.equal(JSON.stringify(result).includes(dispatcher.token), false)
      return body
    }
    const snapshot = () => Promise.all(['clients', 'jobs', 'slots', 'bookings', 'workflow_runs', 'workflow_steps', 'workflow_holds', 'audit_outbox', 'idempotency_keys', 'access_tokens', 'memberships'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(result => result.results.map(row => { const copy = { ...row }; delete copy.last_used_at;
      // Audit delivery continues after the request; compare immutable event data
      // and row membership while ignoring the relay's retry/delivery bookkeeping.
      if (table === 'audit_outbox') for (const field of ['attempts', 'next_attempt_at', 'delivered_at', 'last_error']) delete copy[field];
      return copy }))))
    return { scratch, base, org, otherOrg, db, call, json, dispatcher, viewer, restricted, revoked, expired, owner, issue, connect, tool, snapshot, close, sanitize, counts: () => ({ directHttpResponses: responses, mcpCalls }),
      tick: () => call('/internal/workflows/run', 'POST', {}, session, org, { 'X-Internal-Token': internal }).then(response => json(response)),
      relay: () => call('/internal/relay', 'POST', {}, session, org, { 'X-Internal-Token': internal }).then(response => json(response)),
    }
  } catch (error) { await close(); throw error }
}
export type Fixture = Awaited<ReturnType<typeof startFixture>>
