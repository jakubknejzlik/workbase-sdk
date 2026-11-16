import '../../../scripts/local-network-only.cjs'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { getPlatformProxy } from 'wrangler'
import { afterEach, expect, it } from 'vitest'
import { migrateInstance, readMigrationFiles } from '@workbasehq/core/infra'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { expectedPluginMigrations, pluginMigrationStatus, splitStatements } from '@workbasehq/core/kernel/migrations'
import { magicSession } from '../../../scripts/identity-session.mjs'
import { createServer } from '../src/server.ts'
import type { CompositionChange } from '../src/schemas.ts'
import { parseRuntimeSource } from '../src/composition/runtime-source.ts'

const opsToken = randomBytes(32).toString('hex'), authSecret = randomBytes(32).toString('hex')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Composed instance cleanup failed')
})
const changes: CompositionChange[] = [
  { kind: 'set_plugin', plugin: 'organizations', options: { allowCreate: false } },
  { kind: 'set_plugin', plugin: 'local-auth', options: { methods: ['magic-link'] } },
  { kind: 'set_plugin', plugin: 'mail-outbox' },
  { kind: 'set_plugin', plugin: 'audit' },
  { kind: 'set_plugin', plugin: 'console' },
  { kind: 'set_interactive', interactive: true },
]
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'composition-functional-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const { server, store, workflow } = await createServer({ root })
  cleanups.push(() => server.close())
  expect(await workflow.call('bootstrap_instance', { id: 'functional', target: 'cloudflare-github' })).toMatchObject({ ok: true })
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  execFileSync('bun', [resolve('packages/core/src/migrations/schema-cli.ts'), 'plan', '--root', root, '--init'], { encoding: 'utf8' })
  execFileSync('bun', [resolve('packages/core/src/openapi/cli.ts'), '--root', root, '--write'], { encoding: 'utf8' })
  await writeFile(join(root, 'runtime.ts'), `import { identity } from '@workbasehq/plugins/identity'
import { permissions } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import config from './config'
export default { ...config, plugins: [identity, permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' }), members, machineCredentials()] }
`)
  // This API suite needs no static console assets/build; the installed smoke covers those bytes.
  const wranglerPath = join(root, 'wrangler.jsonc'), wrangler = JSON.parse(await readFile(wranglerPath, 'utf8'))
  delete wrangler.assets
  await writeFile(wranglerPath, JSON.stringify(wrangler))
  await store.init()
  const client = new Client({ name: 'composed-functional-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport); await client.connect(clientTransport)
  cleanups.push(() => client.close())
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as any
  const proposal = await call('propose_composition', { instance: 'functional', baseRevision: 1, changes })
  expect(proposal).toMatchObject({ ok: true, kind: 'composition_change' })
  return { root, store, call, proposalId: proposal.proposalId as string }
}
async function boot(root: string) {
  const reservation = netServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const origin = `http://127.0.0.1:${port}`
  await writeFile(join(root, '.dev.vars'), `INTERNAL_TOKEN=${opsToken}\nOPS_TOKEN=${opsToken}\nBETTER_AUTH_SECRET=${authSecret}\nAUTH_BASE_URL=${origin}\n`, { mode: 0o600 })
  let logs = '', error: unknown
  const worker: ChildProcess = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', '.wrangler/state', '--log-level', 'error'], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${resolve('scripts/local-network-only.cjs')}`,
      CLOUDFLARE_CF_FETCH_ENABLED: 'false', CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false',
      WRANGLER_REGISTRY_PATH: join(root, 'registry'), WRANGLER_LOG_PATH: join(root, 'wrangler.log'),
    },
  })
  worker.on('error', value => { error = value })
  for (const stream of [worker.stdout, worker.stderr]) stream!.on('data', chunk => { logs = (logs + chunk.toString()).slice(-12000) })
  let stopping: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    const exited = worker.exitCode !== null || worker.signalCode !== null ? Promise.resolve() : once(worker, 'exit')
    const kill = (signal: NodeJS.Signals) => { if (worker.pid) { try { process.kill(-worker.pid, signal) } catch { /* already exited */ } } }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      kill('SIGTERM')
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000) })])
    } finally { clearTimeout(timer); kill('SIGKILL'); await exited }
  })()
  cleanups.push(stop)
  for (let attempt = 0; attempt < 300; attempt++) {
    if (error || worker.exitCode !== null) throw Error(`Worker failed: ${error ?? logs}`)
    if (await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)) return { origin, stop }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error('Worker readiness timeout: ' + logs)
}

it('boots the MCP-promoted template composition and passes its functional contract without EMAIL', async () => {
  const { root, store, call, proposalId } = await fixture()
  expect(await call('validate', { proposalId })).toMatchObject({ ok: true, requirements: expect.arrayContaining([
    expect.objectContaining({ requirement: 'AUDIT_KV', satisfied: true, severity: 'error' }),
    expect.objectContaining({ requirement: 'better-auth-als-preseed', satisfied: true, severity: 'warning' }),
    expect.objectContaining({ requirement: 'EMAIL', satisfied: false, severity: 'warning' }),
  ]) })
  expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
  expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true, appliesToDatabase: false })
  const promoted = await store.load('functional', { canonicalRuntime: true })
  const template = await readFile(resolve('packages/mcp/templates/standalone/runtime.ts'), 'utf8')
  // Factory descriptors and options match the template, including allowCreate=false.
  expect(parseRuntimeSource(promoted.runtimeSource!)).toEqual(parseRuntimeSource(template))
  const kernel = new KernelRegistry(promoted.runtime!)
  const configPath = join(root, 'wrangler.jsonc')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  expect(config.send_email).toBeUndefined()
  const proxy = await getPlatformProxy({ configPath, remoteBindings: false, persist: { path: join(root, '.wrangler/state/v3') } })
  cleanups.push(() => proxy.dispose())
  const db = proxy.env.DB as unknown as D1Database
  await migrateInstance(sql => db.batch(splitStatements(sql).map(statement => db.prepare(statement))), await readMigrationFiles(join(root, 'migrations')), kernel)
  const { origin, stop } = await boot(root)
  expect((await fetch(origin + '/me')).status).toBe(401)
  const request = async (path: string, method = 'GET', body?: unknown, token?: string, org?: string, extra: Record<string, string> = {}) => fetch(origin + path, {
    method, signal: AbortSignal.timeout(15000), headers: { Origin: origin, 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(org ? { 'X-Organization-Id': org } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = async (response: Response, status = 200) => { expect(response.status, await response.clone().text()).toBe(status); return response.json() as Promise<any> }
  const admin = await magicSession(origin, db, 'admin@example.test')
  expect(await db.prepare("SELECT count(*) AS n FROM email_outbox WHERE recipient='admin@example.test' AND subject='Workbase sign-in'").first('n')).toBe(1)
  await json(await request('/me/profile', 'PATCH', { firstName: 'Admin', lastName: 'Person' }, admin))
  expect((await request('/orgs', 'POST', { name: 'Disabled self service' }, admin)).status).toBe(403)
  const provision = async (name: string, ownerEmail: string) => json(await request('/internal/organizations', 'POST', { name, ownerEmail }, undefined, undefined, { 'X-Internal-Token': opsToken }), 201)
  const orgA = await provision('Organization A', 'admin@example.test')
  expect(orgA.role).toBe('admin')
  expect(await db.prepare('SELECT role FROM memberships WHERE organization_id=?').bind(orgA.id).first('role')).toBe('admin')
  const me = await json(await request('/me', 'GET', undefined, admin))
  expect(me.memberships).toEqual(expect.arrayContaining([expect.objectContaining({ organization_id: orgA.id, role: 'admin' })]))
  const row = await json(await request('/api/worker', 'POST', { name: 'Worker A' }, admin, orgA.id, { 'Idempotency-Key': crypto.randomUUID() }), 201)
  const rowPath = '/api/worker/' + row.id
  const invite = await json(await request(rowPath + '/actions/invite', 'POST', { email: 'staff@example.test' }, admin, orgA.id), 201)
  const staff = await magicSession(origin, db, 'staff@example.test')
  await json(await request('/me/profile', 'PATCH', { firstName: 'Staff', lastName: 'Person' }, staff))
  const invitation = await db.prepare("SELECT body FROM email_outbox WHERE recipient='staff@example.test' AND body LIKE 'Accept: %'").first<string>('body')
  expect(invitation).toBeTruthy()
  const token = new URL(invitation!.slice('Accept: '.length)).searchParams.get('token')
  await json(await request('/invitations/resolve', 'POST', { token }, staff))
  await json(await request('/invitations/' + invite.invitation_id + '/accept', 'POST', {}, staff), 201)
  expect((await json(await request('/me', 'GET', undefined, staff))).memberships).toEqual(expect.arrayContaining([expect.objectContaining({ organization_id: orgA.id, role: 'staff' })]))
  expect((await json(await request(rowPath, 'GET', undefined, staff, orgA.id))).id).toBe(row.id)
  const other = await magicSession(origin, db, 'other@example.test')
  const orgB = await provision('Organization B', 'other@example.test')
  await json(await request('/me/profile', 'PATCH', { firstName: 'Other', lastName: 'Person' }, other))
  const foreign = await json(await request('/api/worker', 'POST', { name: 'Worker B' }, other, orgB.id, { 'Idempotency-Key': crypto.randomUUID() }), 201)
  for (const org of [orgA.id, orgB.id]) {
    const denied = await request('/api/worker/' + foreign.id, 'GET', undefined, staff, org)
    expect([403, 404]).toContain(denied.status)
    const list = await request('/api/worker', 'GET', undefined, staff, org)
    if (list.ok) expect(JSON.stringify(await list.json())).not.toContain(foreign.id)
    else expect([403, 404]).toContain(list.status)
  }
  const audit = await db.prepare('SELECT payload FROM audit_outbox WHERE organization_id=?').bind(orgA.id).all<{ payload: string }>()
  expect(audit.results.map(row => JSON.parse(row.payload))).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'worker.created', entity: 'worker', entity_id: row.id, organization_id: orgA.id })]))
  const expected = await expectedPluginMigrations(kernel.plugins, kernel.config)
  const hash = createHash('sha256').update(JSON.stringify(expected)).digest('hex')
  expect(await pluginMigrationStatus(db, kernel.plugins, kernel.config)).toEqual({ expected: hash, applied: hash })
  await stop()
  const entryPath = join(root, 'src/index.ts'), entry = await readFile(entryPath, 'utf8')
  await writeFile(entryPath, entry.replace("import '@workbasehq/plugins/local-auth/better-auth-als-preseed'\n", ''))
  const noPreseed = await boot(root)
  // Current runtime can complete the full login journey without preseed. Report the safeguard as a warning.
  await magicSession(noPreseed.origin, db, 'no-preseed@example.test')
  await noPreseed.stop()
  await writeFile(entryPath, entry)
  // Live negative controls use the exact promoted instance and the same D1.
  await writeFile(configPath, JSON.stringify({ ...config, kv_namespaces: [] }))
  const missingKv = await boot(root)
  const unavailable = await fetch(missingKv.origin + '/audit/events', { headers: { Authorization: `Bearer ${admin}`, 'X-Organization-Id': orgA.id } })
  expect(unavailable.status).toBe(500)
  await missingKv.stop()
  await writeFile(configPath, JSON.stringify({ ...config, queues: undefined }))
  const noQueue = await boot(root)
  expect((await fetch(noQueue.origin + '/me')).status).toBe(401)
  const noQueueToken = await magicSession(noQueue.origin, db, 'no-queue@example.test')
  const noQueueOrgResponse = await fetch(noQueue.origin + '/internal/organizations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': opsToken }, body: JSON.stringify({ name: 'No queue organization', ownerEmail: 'no-queue@example.test' }) })
  expect(noQueueOrgResponse.status).toBe(201)
  const noQueueOrg = await noQueueOrgResponse.json() as { id: string }
  expect(await db.prepare('SELECT delivered_at FROM audit_outbox WHERE organization_id=?').bind(noQueueOrg.id).first('delivered_at')).toBeTruthy()
  const events = await fetch(noQueue.origin + '/audit/events', { headers: { Authorization: `Bearer ${noQueueToken}`, 'X-Organization-Id': noQueueOrg.id } })
  expect(events.status).toBe(200)
  expect((await events.json() as { data: unknown[] }).data.length).toBeGreaterThan(0)
})

it('blocks missing audit KV, revokes earlier proofs, and permits repair through validation', async () => {
  const { root, call, proposalId } = await fixture()
  const path = join(root, 'wrangler.jsonc'), source = await readFile(path, 'utf8'), config = JSON.parse(source)
  const runtime = await readFile(join(root, 'runtime.ts'), 'utf8')
  expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
  expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
  await writeFile(path, JSON.stringify({ ...config, kv_namespaces: [] }))
  expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'composition_requirements_unsatisfied' } })
  expect(await call('validate', { proposalId })).toMatchObject({ ok: false, error: { code: 'composition_requirements_unsatisfied', details: {
    requirements: expect.arrayContaining([expect.objectContaining({ plugin: 'audit', requirement: 'AUDIT_KV', satisfied: false, severity: 'error' })]),
  } } })
  const saved = JSON.parse(await readFile(join(root, 'proposals', `${proposalId}.json`), 'utf8'))
  expect(saved).toMatchObject({ status: 'proposed' })
  expect(saved.validation).toBeUndefined(); expect(saved.verification).toBeUndefined()
  expect(await readFile(join(root, 'runtime.ts'), 'utf8')).toBe(runtime)
  await writeFile(path, source)
  expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
  expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
  expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'verification_required' } })
  expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
  expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true })
  expect(await readFile(path, 'utf8')).toBe(source)
})

it('reports missing preseed, EMAIL and EVENTS_QUEUE as nonblocking requirements', async () => {
  const { root, call, proposalId } = await fixture()
  const entryPath = join(root, 'src/index.ts'), entry = await readFile(entryPath, 'utf8')
  await writeFile(entryPath, entry.replace("import '@workbasehq/plugins/local-auth/better-auth-als-preseed'\n", ''))
  const path = join(root, 'wrangler.jsonc'), config = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...config, queues: undefined }))
  expect(await call('validate', { proposalId })).toMatchObject({ ok: true, requirements: expect.arrayContaining([
    expect.objectContaining({ plugin: 'local-auth', requirement: 'better-auth-als-preseed', satisfied: false, severity: 'warning' }),
    expect.objectContaining({ plugin: 'audit', requirement: 'EVENTS_QUEUE', satisfied: false, severity: 'warning' }),
    expect.objectContaining({ plugin: 'mail-outbox', requirement: 'EMAIL', satisfied: false, severity: 'warning' }),
    expect.objectContaining({ plugin: 'audit', requirement: 'AUDIT_KV', satisfied: true, severity: 'error' }),
  ]) })
})

it.each(['wrangler.jsonc', 'src/index.ts'])('binds validation to requirement input bytes in %s', async path => {
  const { root, call, proposalId } = await fixture()
  expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
  const original = await readFile(join(root, path), 'utf8')
  // Comments preserve requirement satisfaction, but still change the proof's inputs.
  await writeFile(join(root, path), original + '\n// requirement input changed\n')
  expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
  expect(await call('validate', { proposalId })).toMatchObject({ ok: true })
})
