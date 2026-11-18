import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createServer as createMailServer } from 'node:http'
import { constants, platform, release, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { Manifest } from '../../packages/plugins/console/ui/src/check'
import { consoleArtifactsSHA, consoleHTMLStamps, readConsoleArtifacts } from '../../packages/core/src/console-build'
import { deferTempDirCleanup } from './test-temp-dir.mjs'

declare const document: { documentElement: { scrollWidth: number } }
declare const window: { innerWidth: number }
declare const localStorage: { setItem(key: string, value: string): void }
const root = resolve(import.meta.dirname, '../..')
const guard = join(root, 'scripts/lib/installed-consumer-network.cjs')
const processGuard = join(root, 'scripts/lib/installed-consumer-processes.cjs')
const supervisor = join(root, 'scripts/lib/installed-consumer-supervisor.cjs')
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
export type BuildTimings = { npm_install_ms: number; npm_ci_ms: number; typecheck_ms: number }

/** Test-only overlay, never copied by init or packed into any SDK package. */
export function applyInstalledConsumerFixture(consumer: string): string[] {
  const fixture = join(root, 'scripts/fixtures/installed-consumer')
  const patches: { path: string; before: string; after: string }[] = json(join(fixture, 'patches.json'))
  for (const patch of patches) {
    const file = join(consumer, patch.path), source = readFileSync(file, 'utf8')
    assert.equal(source.split(patch.before).length, 2, `Fixture anchor changed: ${patch.path}`)
    writeFileSync(file, source.replace(patch.before, patch.after))
  }
  cpSync(join(fixture, 'locales/cs'), join(consumer, 'locales/cs'), { recursive: true })
  return patches.map(patch => patch.path)
}

function within(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}
/** Resolve symlinks before allowing evidence writes, including a not-yet-created leaf. */
export function evidenceDirectory(value: string | undefined, repository = root, archives = join(root, 'dist-sdk')): string | undefined {
  if (!value) return undefined
  let ancestor = resolve(value), suffix = ''
  while (!existsSync(ancestor)) { suffix = join(basename(ancestor), suffix); ancestor = dirname(ancestor) }
  const target = resolve(realpathSync(ancestor), suffix)
  assert(!within(realpathSync(repository), target) && !within(existsSync(archives) ? realpathSync(archives) : resolve(archives), target), 'Evidence must be outside the repository and dist-sdk')
  mkdirSync(target, { recursive: true })
  return target
}

export function assertInstalledArtifacts(consumer: string) {
  const lock = json(join(consumer, 'package-lock.json'))
  const sdk = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/@workbasehq\/[^/]+$/.test(path))
  assert.deepEqual(sdk.map(([path]) => path).sort(), ['core', 'mcp', 'plugins'].map(name => 'node_modules/@workbasehq/' + name))
  assert(!/ui-v3|test-support|workspace:/.test(JSON.stringify(lock)))
  const mcp = json(join(consumer, '.mcp.json'))
  assert.deepEqual(Object.keys(mcp.mcpServers), ['workbase_data', 'workbase_ops', 'workbase_config'])
  assert.deepEqual(mcp.mcpServers.workbase_config, { command: 'bun',
    args: ['./node_modules/@workbasehq/mcp/src/bin.ts', 'config', '--root', '.'] })
  // Include hidden directories, but exclude third-party installs and local runtime state.
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['node_modules', '.wrangler', '.sst', 'vendor'].includes(entry.name)) continue
      assert(!/^(?:archive|archives|versions)$/.test(entry.name), `Unexpected history directory: ${entry.name}`)
      walk(join(path, entry.name))
    }
  }
  walk(consumer)
  const manifest: Manifest = json(join(consumer, '.workbase-ui/manifest.json'))
  const paths = ['/workers', '/workers/$workerId', '/workers/$workerId/edit', '/workers/new'].sort()
  assert.deepEqual(manifest.routes.map(route => route.path).sort(), paths)
  const tree = readFileSync(join(consumer, '.workbase-ui/routeTree.gen.ts'), 'utf8')
  assert.deepEqual([...tree.matchAll(/fullPath: '([^']+)'/g)].map(match => match[1]).sort(), paths)
  const fields = Object.keys(manifest.entities.worker.fields).sort()
  const schema = json(join(consumer, 'schema.lock.json'))
  const columns: { name: string; implicit?: boolean }[] = schema.tables.find((table: { name: string }) => table.name === 'worker').columns
  assert.deepEqual(columns.filter(column => !column.implicit).map(column => column.name).sort(), fields)
  const rowSchema = json(join(consumer, 'openapi.json')).components.schemas.Row_worker
  const properties = rowSchema.properties
  // Response metadata and projected relations (including user_account) are not D1 columns.
  assert.deepEqual(Object.keys(properties).filter(name => !name.startsWith('__') && !Object.hasOwn(rowSchema['x-workbase-relations'] ?? {}, name)).sort(), columns.map(column => column.name).sort())
  assert.deepEqual(Object.entries(properties).filter(([, field]) => Object.hasOwn(field as object, 'x-workbase-field')).map(([name]) => name).sort(), fields)
  return manifest
}

async function settlesWithin(pending: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([pending.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

async function stop(child: ChildProcess | undefined) {
  if (!child) return
  const running = () => child.exitCode === null && child.signalCode === null
  const controller = new AbortController()
  const closed = running() ? once(child, 'exit', { signal: controller.signal }) : Promise.resolve()
  const signal = (name: NodeJS.Signals) => {
    if (running()) child.kill(name)
  }
  try {
    signal('SIGTERM')
    await settlesWithin(closed, 5000)
    signal('SIGKILL')
    await settlesWithin(closed, 1000)
  } finally { controller.abort() }
}

/** Node owns the live phase so its socket guard also covers Wrangler and Playwright. */
export async function runInstalledConsumerLive(consumer: string, env: NodeJS.ProcessEnv, timings: BuildTimings, archives: string) {
  const started = performance.now()
  const directory = mkdtempSync(join(tmpdir(), 'workbase-live-processes-')), resultFile = join(directory, 'result.json')
  const releaseDirectories = deferTempDirCleanup()
  let interruption: NodeJS.Signals | undefined
  let cancel!: () => void
  const canceled = new Promise<void>(resolve => { cancel = resolve })
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const listeners = signals.map(signal => {
    const listener = () => { interruption ??= signal; cancel() }
    process.on(signal, listener)
    return listener
  })
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let child: ChildProcess | undefined
  let unsettled = false
  try {
    child = spawn('node', [supervisor, resultFile, '--require', processGuard, '--require', guard, '--import', join(root, 'node_modules/tsx/dist/esm/index.mjs'), fileURLToPath(import.meta.url), consumer, JSON.stringify(timings), archives], {
      cwd: consumer, env: { ...env, NODE_OPTIONS: '--require=' + JSON.stringify(processGuard) + ' --require=' + JSON.stringify(guard), WRANGLER_SEND_METRICS: 'false', CI: 'true', BROWSER: 'none' }, stdio: ['pipe', 'inherit', 'inherit'], detached: true,
    })
    // The pipe is a lifeline, not a request/response channel. A dead supervisor
    // may close it before our finalizer does.
    child.stdin!.on('error', () => {})
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('Installed consumer live timed out after 240000 ms')), 240000) })
    const result = await Promise.race([once(child, 'exit', { signal: controller.signal }), deadline, canceled])
    if (result && !interruption) {
      assert(existsSync(resultFile), 'Installed consumer live result missing')
      const status = json(resultFile)
      // Success needs the supervisor's final-stage marker: a supervisor killed
      // during its sweep window must not authorize a run with live descendants.
      assert.equal(status.final, true, 'Installed consumer supervisor did not finish teardown')
      assert.equal(status.code, 0, `Installed consumer live failed (${status.error ?? status.signal ?? status.code})`)
    }
  } finally {
    clearTimeout(timeout)
    try {
      // EOF also happens if this parent crashes or is SIGKILLed. The supervisor
      // owns escalation, including sweeping descendants after a successful run.
      child?.stdin?.destroy()
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        // Fail closed below: an unsettled supervisor never reports success.
        unsettled = !await settlesWithin(once(child, 'exit', { signal: controller.signal }), 13000)
      }
    } finally {
      controller.abort()
      signals.forEach((signal, index) => process.off(signal, listeners[index]))
      rmSync(directory, { recursive: true, force: true })
      releaseDirectories()
      if (interruption) {
        // Let the directory helper finish now that group cleanup is complete.
        // If another observer returns, restore the default signal disposition.
        const exitCode = 128 + constants.signals[interruption]
        setTimeout(() => process.exit(exitCode), 2000)
        process.emit(interruption)
        process.removeAllListeners(interruption)
        process.kill(process.pid, interruption)
        await new Promise<never>(() => {})
      }
    }
  }
  // Reached only without an earlier error, which keeps the primary failure.
  if (unsettled) throw Error('Installed consumer supervisor did not exit within 13000 ms')
  console.log(`Installed consumer added live wall time: ${Math.round(performance.now() - started)} ms`)
}

async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function live(consumer: string, timings: BuildTimings, archives: string) {
  const started = performance.now(), evidence = evidenceDirectory(process.env.WORKBASE_EVIDENCE_DIR, root, archives)
  const manifest = assertInstalledArtifacts(consumer)
  const port = await freePort(), origin = `http://127.0.0.1:${port}`
  const opsToken = 'example-ops'
  writeFileSync(join(consumer, '.dev.vars'), `BETTER_AUTH_SECRET=synthetic-access-secret-at-least-32\nAUTH_BASE_URL=${origin}\nOPS_TOKEN=${opsToken}\n`, { mode: 0o600 })
  // This module resolves every SDK and Wrangler import from the installed consumer.
  // CLI --persist-to appends /v3; getPlatformProxy's explicit path does not.
  const bridge = join(consumer, '.smoke/local-db.ts')
  writeFileSync(bridge, `import assert from 'node:assert/strict'
import { getPlatformProxy } from 'wrangler'
import { SESSION_COOKIE } from '@workbasehq/core/session-contract'
import { migrateInstance, readMigrationFiles } from '@workbasehq/core/infra'
import { splitStatements } from '@workbasehq/core/kernel/migrations'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import mailbox from '@workbasehq/core/dev-mailbox'
import config from '../runtime'
export async function open() {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: './wrangler.jsonc', persist: { path: '.wrangler/state/v3' }, remoteBindings: false })
  const db = proxy.env.DB
  const query = async (sql: string) => db.batch(splitStatements(sql).map(statement => db.prepare(statement)))
  try {
    const calls: string[] = []
    const tracked = async (sql: string) => { calls.push(sql); return query(sql) }
    const kernel = new KernelRegistry(config), files = await readMigrationFiles('./migrations')
    assert.equal(kernel.config.pluginConfig?.organizations?.allowCreate, false)
    const first = await migrateInstance(tracked, files, kernel)
    assert.equal(first.applied, 1)
    const ledger = await db.prepare('SELECT namespace,name FROM _plugin_migrations ORDER BY rowid').all()
    assert.equal(ledger.results[0].namespace, 'workbase-sdk')
    assert(ledger.results.some(row => row.namespace === 'identity'))
    assert(ledger.results.some(row => row.namespace === 'members'))
    const sdkAt = calls.findIndex(sql => sql.includes("INSERT INTO _plugin_migrations") && sql.includes("'workbase-sdk'"))
    const pluginAt = calls.findIndex(sql => sql.includes("INSERT INTO _plugin_migrations") && sql.includes("'identity'"))
    const domainAt = calls.findIndex(sql => sql.includes("INSERT INTO _migrations"))
    assert(sdkAt >= 0 && pluginAt > sdkAt && domainAt > pluginAt)
    assert.equal((await db.prepare('SELECT filename FROM _migrations').first()).filename, '0001_r1.sql')
    assert.equal((await db.prepare('SELECT revision FROM instance_meta').first()).revision, 1)
    const snapshot = async () => JSON.stringify({ plugins: (await db.prepare('SELECT * FROM _plugin_migrations ORDER BY rowid').all()).results, domain: (await db.prepare('SELECT * FROM _migrations').all()).results, meta: (await db.prepare('SELECT * FROM instance_meta').all()).results })
    const before = await snapshot()
    const repeated = await migrateInstance(query, files, kernel)
    assert.equal(repeated.applied, 0)
    assert.equal(await snapshot(), before)
    assert.equal(first.pluginMigrations, repeated.pluginMigrations)
    console.log('Live migration: SDK → plugins → 0001_r1.sql; initial=1, rerun=0; ledgers unchanged')
    const readMail = async (recipient: string) => {
      const token = 'synthetic-mailbox-secret-at-least-32'
      const response = await mailbox.fetch(new Request('http://127.0.0.1/messages?' + new URLSearchParams({ recipient }), {
        headers: { Authorization: 'Bearer ' + token },
      }), { DB: db, STAGE: 'test', DEV_MAILBOX_TOKEN: token })
      assert.equal(response.status, 200, 'Installed mailbox handler must read the shared D1')
      return (await response.json()).messages
    }
    const mailStatus = (id: string) => db.prepare('SELECT delivery_status,attempts,sent_at,last_error FROM email_outbox WHERE id=?').bind(id).first()
    return { readMail, mailStatus, dispose: proxy.dispose, sessionCookie: SESSION_COOKIE }
  } catch (error) { await proxy.dispose(); throw error }
}
`)
  const { open } = await import(pathToFileURL(bridge).href)
  const proxy: { readMail(recipient: string): Promise<{ id: string; subject: string; body: string }[]>; mailStatus(id: string): Promise<{ delivery_status: string; attempts: number; sent_at: string | null; last_error: string | null }>; sessionCookie: string; dispose(): Promise<void> } = await open()
  // Test-only transport: only EMAIL.send can populate this inbox. Never render or
  // sign in the harness, and never treat the stored outbox inputs as delivered mail.
  const delivered: { to: string; from: string; subject: string; text: string; html: string }[] = []
  const mailPath = '/' + crypto.randomUUID()
  const mailServer = createMailServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== mailPath) { response.writeHead(404).end(); return }
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      const message = JSON.parse(body)
      assert(['to', 'from', 'subject', 'text', 'html'].every(key => typeof message[key] === 'string'))
      delivered.push(message)
      response.writeHead(204).end()
    } catch { response.writeHead(400).end() }
  })
  let worker: ChildProcess | undefined, browser: Browser | undefined, logs = ''
  const startWorker = async () => {
    logs = ''
    worker = spawn('node', [join(consumer, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '.smoke/live-worker.mjs', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', '.wrangler/state', '--log-level', 'error'], { cwd: consumer, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = (data: Buffer) => { logs = (logs + data.toString()).slice(-12000) }
    worker.stdout!.on('data', output); worker.stderr!.on('data', output)
    worker.on('error', error => { logs += String(error) })
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      assert(worker.exitCode === null, `Worker exited: ${logs}`)
      try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) })).ok) return } catch { /* not yet listening */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw Error('Worker readiness timeout: ' + logs)
  }
  const contexts: BrowserContext[] = [], forbidden: string[] = [], pageErrors: string[] = []
  let teardown: Promise<void> | undefined
  const cleanup = () => teardown ??= (async () => {
    const closing = (async () => {
      const results = await Promise.allSettled(contexts.map(context => context.close()))
      results.push(...await Promise.allSettled([browser?.close(), stop(worker), proxy.dispose()]))
      if (mailServer.listening) await new Promise<void>((resolve, reject) => mailServer.close(error => error ? reject(error) : resolve()))
      const failures = results.filter(result => result.status === 'rejected')
      assert.equal(failures.length, 0, 'Live process cleanup failed')
    })()
    assert(await settlesWithin(closing, 10000), 'Live process cleanup timed out')
  })()
  const interrupted = () => { void cleanup().finally(() => process.exit(143)) }
  process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted)
  try {
    mailServer.listen(0, '127.0.0.1')
    await once(mailServer, 'listening')
    const mailAddress = mailServer.address()
    assert(mailAddress && typeof mailAddress !== 'string')
    writeFileSync(join(consumer, '.smoke/live-worker.mjs'), `import worker from '../src/index.ts'
export default { ...worker, fetch(request, env, ctx) {
  return worker.fetch(request, { ...env, EMAIL_FROM: 'login@example.test', EMAIL: { async send(message) {
    const response = await fetch(${JSON.stringify(`http://127.0.0.1:${mailAddress.port}${mailPath}`)}, { method: 'POST', body: JSON.stringify(message) })
    if (!response.ok) throw Error('Installed consumer mail transport rejected delivery')
  } } }, ctx)
} }
`)
    await startWorker()
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {})
    const newContext = async () => {
      const context = await browser!.newContext({ baseURL: origin })
      contexts.push(context)
      await context.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (url.origin !== origin) { forbidden.push('non-consumer origin'); await route.abort(); return }
        if (/(?:^|\/)(schema|console-model|console-info|bootstrap)(?:\/|$)/.test(url.pathname)) forbidden.push(url.pathname)
        await route.continue()
      })
      context.on('page', page => { page.setDefaultTimeout(10000); page.on('pageerror', error => pageErrors.push(error.message)) })
      return context
    }
    // APIRequestContext retains Secure cookies but does not automatically send them
    // over HTTP loopback. Forward those same cookies explicitly for API assertions.
    const call = async (context: BrowserContext, path: string, method = 'GET', data?: unknown, org?: string, headers: Record<string, string> = {}, expected = 200) => {
      const response = await context.request.fetch(path, { method, data, maxRedirects: 0, timeout: 15000, headers: {
        Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
        Cookie: (await context.cookies()).map(cookie => cookie.name + '=' + cookie.value).join('; '),
        ...(org ? { 'X-Organization-Id': org } : {}), ...headers,
      } })
      assert.equal(response.status(), expected, `${method} ${path.split('?')[0]}: ${await response.text()}`)
      return response
    }
    const signIn = async (email: string) => {
      const context = await newContext()
      await call(context, '/auth/sign-in/magic-link', 'POST', { email, callbackURL: '/me' })
      const [mail] = await proxy.readMail(email)
      assert(mail, 'Magic link must come through the installed mailbox handler')
      const message = delivered.find(message => message.to === email && message.subject === mail.subject)
      const link = message?.text.match(/^https?:\/\/\S+$/m)?.[0]
      assert(link, 'Magic link must come through installed EMAIL.send')
      assert.equal(link, mail.body)
      assert.equal(new URL(link).origin, origin)
      await call(context, link, 'GET', undefined, undefined, {}, 302)
      assert((await context.cookies()).some(cookie => cookie.name === proxy.sessionCookie))
      await call(context, '/me/profile', 'PATCH', { firstName: 'Synthetic', lastName: 'Person' })
      return context
    }
    const provisionOrganization = async (name: string, ownerEmail: string) => {
      const response = await fetch(origin + '/internal/organizations', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': opsToken }, body: JSON.stringify({ name, ownerEmail }),
      })
      assert.equal(response.status, 201, 'Operator provisioning must create the organization')
      return await response.json() as { id: string; role: string }
    }
    const admin = await signIn('admin@example.test')
    await call(admin, '/orgs', 'POST', { name: 'Self-service forbidden' }, undefined, {}, 403)
    const orgA = await provisionOrganization('Organization A', 'admin@example.test')
    assert.equal(orgA.role, 'admin')
    const memberships = (await (await call(admin, '/me')).json()).memberships
    assert(memberships.some((membership: { role: string; organization_id: string }) => membership.role === 'admin' && membership.organization_id === orgA.id))
    let row = await (await call(admin, '/api/worker', 'POST', { name: 'Persistent worker', note: 'Keep this' }, orgA.id, { 'Idempotency-Key': crypto.randomUUID() }, 201)).json()
    const rowPath = '/api/worker/' + row.id
    await stop(worker); await startWorker()
    const persisted = await (await call(admin, rowPath, 'GET', undefined, orgA.id)).json()
    assert.equal(persisted.note, 'Keep this'); assert.equal(persisted.name, 'Persistent worker')
    const stale = row.version
    row = await (await call(admin, rowPath, 'PATCH', { name: 'Persistent renamed' }, orgA.id, { 'If-Match': `"${row.version}"` })).json()
    assert.equal(row.note, 'Keep this')
    assert.equal((await (await call(admin, rowPath, 'GET', undefined, orgA.id)).json()).note, 'Keep this', 'Omitted PATCH must retain the stored note')
    row = await (await call(admin, rowPath, 'PATCH', { note: null }, orgA.id, { 'If-Match': `"${row.version}"` })).json()
    assert.equal(row.note, null)
    assert.equal((await (await call(admin, rowPath, 'GET', undefined, orgA.id)).json()).note, null)
    const conflict = await (await call(admin, rowPath, 'PATCH', { name: 'Stale' }, orgA.id, { 'If-Match': `"${stale}"` }, 409)).json()
    assert.equal(conflict.error, 'version_conflict')
    assert.equal((await (await call(admin, rowPath, 'GET', undefined, orgA.id)).json()).name, 'Persistent renamed')
    const invite = await (await call(admin, rowPath + '/actions/invite', 'POST', { email: 'staff@example.test' }, orgA.id, {}, 201)).json()
    const staff = await signIn('staff@example.test')
    const invitationIntent = (await proxy.readMail('staff@example.test')).find(mail => mail.subject === 'Workbase invitation')
    assert(invitationIntent, 'Invitation intent must come through the installed mailbox handler')
    const invitationMail = delivered.find(message => message.to === 'staff@example.test' && message.text.includes('/invitations/accept?'))
    assert(invitationMail, 'Invitation link must come through installed EMAIL.send')
    const link = invitationMail.text.match(/^https?:\/\/\S+$/m)?.[0]
    assert(link, 'Delivered invitation must contain an acceptance URL')
    assert(invitationMail.html.includes(link), 'Delivered text and HTML must contain the same URL')
    const invitationUrl = new URL(link)
    assert.equal(invitationUrl.origin, origin)
    const token = invitationUrl.searchParams.get('token')
    assert(token && /^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token), 'Delivered invitation must carry mailbox proof')
    const delivery = await proxy.mailStatus(invitationIntent.id)
    assert.equal(delivery.delivery_status, 'sent'); assert.equal(delivery.attempts, 1)
    assert(delivery.sent_at); assert.equal(delivery.last_error, null)
    console.log('Installed invitation delivery:', JSON.stringify(delivery), 'EMAIL.send received rendered text + HTML with signed acceptance URL')
    if (evidence) writeFileSync(join(evidence, 'invitation-delivery.json'), JSON.stringify({ delivery, message: invitationMail }, null, 2).replaceAll(token, '<signed-token>') + '\n')
    await call(staff, '/invitations/resolve', 'POST', { token })
    await call(staff, '/invitations/' + invite.invitation_id + '/accept', 'POST', {}, undefined, {}, 201)
    const staffMe = await (await call(staff, '/me')).json()
    assert(staffMe.memberships.some((membership: { role: string; organization_id: string }) => membership.role === 'staff' && membership.organization_id === orgA.id))
    assert.equal((await (await call(staff, rowPath, 'GET', undefined, orgA.id)).json()).id, row.id)
    const other = await signIn('other@example.test')
    const orgB = await provisionOrganization('Organization B', 'other@example.test')
    assert.notEqual(orgA.id, orgB.id)
    for (const org of [orgA.id, orgB.id]) {
      for (const method of ['GET', 'PATCH']) {
        // Inspect the actual denial status; do not assume out-of-scope and foreign-row failures coincide.
        const response = await other.request.fetch(rowPath, { method, data: method === 'PATCH' ? { name: 'Forbidden' } : undefined, headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', Cookie: (await other.cookies()).map(cookie => cookie.name + '=' + cookie.value).join('; '), 'X-Organization-Id': org, 'If-Match': `"${row.version}"` } })
        assert([403, 404].includes(response.status()), `Cross-org ${method}: ${response.status()}`)
      }
    }
    assert.equal((await (await call(admin, rowPath, 'GET', undefined, orgA.id)).json()).name, 'Persistent renamed')
    // Exactly 26 rows exercise a full page and one remaining row.
    for (let index = 0; index < 25; index++) await call(admin, '/api/worker', 'POST', { name: 'Worker ' + String(index).padStart(2, '0') }, orgA.id, { 'Idempotency-Key': crypto.randomUUID() }, 201)
    const query = { entity: 'worker', select: ['id', 'name', 'version'], limit: 25, orderBy: [{ field: 'name', dir: 'asc' }] }
    const first = await (await call(admin, '/query', 'POST', query, orgA.id)).json()
    assert.equal(first.data.length, 25); assert(first.next_cursor)
    const next = await (await call(admin, '/query', 'POST', { ...query, cursor: first.next_cursor }, orgA.id)).json()
    assert.equal(next.data.length, 1); assert.equal(next.next_cursor, null)
    assert.equal(new Set([...first.data, ...next.data].map(item => item.id)).size, 26)
    const searched = await (await call(admin, '/query', 'POST', { ...query, search: { text: 'Persistent renamed', fields: [manifest.entities.worker.displayField] } }, orgA.id)).json()
    assert.deepEqual(searched.data.map((item: { id: string }) => item.id), [row.id])
    console.log('Step 8: local Worker/D1; mailbox handler magic links + invite/accept; allowCreate=false, ops-provisioned organizations; cross-org denial; restart persistence; omitted/null/conflict; 26-row cursor + display search')

    // Hash the HTTP responses, including the SPA fallback, against the installed
    // Instance bundle built from candidate SDK sources in step 4.
    const assets = join(consumer, 'dist/console')
    const html = readFileSync(join(assets, 'index.html'), 'utf8')
    const metadata = json(join(assets, 'build-meta.json'))
    assert.equal(metadata.sha, consoleArtifactsSHA(await readConsoleArtifacts(assets)), 'Instance metadata must identify the emitted bytes')
    assert.deepEqual(consoleHTMLStamps(html), [metadata.sha])
    const references = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:[?#][^"']*)?)["']/g)].map(match => match[1])
    assert(references.some(path => path.endsWith('.js')) && references.some(path => path.endsWith('.css')))
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
    const hashes: Record<string, string> = {}
    for (const path of ['/sign-in', '/workers', ...references, '/build-meta.json']) {
      const response = await fetch(origin + path)
      assert.equal(response.status, 200, `Console asset ${path}`)
      const expected = readFileSync(join(assets, ['/sign-in', '/workers'].includes(path) ? 'index.html' : path.split('?')[0]))
      hashes[path] = hash(new Uint8Array(await response.arrayBuffer()))
      assert.equal(hashes[path], hash(expected), `Served console differs from Instance build: ${path}`)
    }
    console.log('Served Instance console SHA-256:', JSON.stringify(hashes))
    if (evidence) writeFileSync(join(evidence, 'console-assets.json'), JSON.stringify(hashes, null, 2) + '\n')
    const fits = async (page: Page) => assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Horizontal overflow')
    for (const language of ['cs', 'en']) {
      const titles = json(join(consumer, '.workbase-ui/locales.json'))[language].sdk
      for (const width of [1280, 390]) {
        const guest = await newContext(), signInPage = await guest.newPage()
        await signInPage.setViewportSize({ width, height: 900 })
        await signInPage.addInitScript(language => localStorage.setItem('workbase:language', language), language)
        try {
          await signInPage.goto(origin + '/sign-in')
          await signInPage.getByLabel(titles['auth.email'], { exact: true }).waitFor()
          await signInPage.getByRole('button', { name: titles['auth.signIn'], exact: true }).waitFor()
          assert(await signInPage.locator('link[rel="stylesheet"]').count() > 0, 'Instance console CSS missing')
          await fits(signInPage)
          if (evidence) await signInPage.screenshot({ path: join(evidence, `${language}-${width}-sign-in.png`), fullPage: true })
        } finally { await signInPage.close() }
        const page = await admin.newPage()
        await page.setViewportSize({ width, height: 900 })
        await page.addInitScript(({ language, org }) => { localStorage.setItem('workbase:language', language); localStorage.setItem('workbase:org', org) }, { language, org: orgA.id })
        try {
          for (const [name, path] of [
            ['list', '/workers'], ['detail', `/workers/${row.id}`],
            ['new', '/workers/new'], ['edit', `/workers/${row.id}/edit`],
          ]) {
            await page.goto(origin + path)
            await page.getByRole('heading', { level: 1 }).first().waitFor()
            if (name === 'list' || name === 'detail') await page.getByText('Persistent renamed', { exact: true }).first().waitFor()
            await fits(page)
            if (evidence) await page.screenshot({ path: join(evidence, `${language}-${width}-${name}.png`), fullPage: true })
          }
        } finally { await page.close() }
      }
    }
    await call(admin, rowPath + '/actions/unlink_account', 'POST', {}, orgA.id)
    await call(staff, rowPath, 'GET', undefined, orgA.id, {}, 404)
    const staffRows = await (await call(staff, '/query', 'POST', query, orgA.id)).json()
    assert.deepEqual(staffRows.data, [])
    const deletedPath = '/api/worker/' + next.data[0].id
    await call(admin, deletedPath, 'DELETE', undefined, orgA.id, {}, 204)
    await call(admin, deletedPath, 'GET', undefined, orgA.id, {}, 404)
    // A client disconnect is a regression probe for the unpatched installed Wrangler.
    const { connect } = await import('node:net')
    await new Promise<void>((resolve, reject) => { const socket = connect(port, '127.0.0.1', () => { socket.write('GET /workers HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'); socket.destroy(); resolve() }); socket.on('error', reject) })
    await call(admin, '/health')
    assert.deepEqual(forbidden, []); assert.deepEqual(pageErrors, [])
    console.log('Step 9: 20 Instance console route/viewport/language renders; magic-link form, CSS, headings, overflow, page errors; served hashes equal Instance build; unlink denies staff; delete/read-404; negative artifacts and browser requests verified')
    const timing = { event: 'installed_consumer_timing', os: platform(), os_release: release(), node: process.version, bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(), ...timings, live_ms: Math.round(performance.now() - started) }
    const line = JSON.stringify(timing)
    console.log(line)
    if (evidence) writeFileSync(join(evidence, 'timing.json'), line + '\n')
  } catch (error) { console.error('Installed Worker log tail:', logs); throw error }
  finally {
    process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted)
    await cleanup()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [consumer, timing, archives] = process.argv.slice(2)
  assert(consumer && timing && archives)
  await live(consumer, JSON.parse(timing), archives)
}
