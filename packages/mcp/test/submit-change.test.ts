import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { json, Store } from '../src/storage.ts'
import { Workflow } from '../src/workflow.ts'
import { RestGitHub, notConfigured, type TreeEntry, type CheckRun } from '../src/github.ts'
import * as planning from '../src/planning.ts'
import * as disposable from '../src/disposable.ts'
import { parseProposal } from '../src/proposals.ts'
import { promotionHash } from '../src/submit-change.ts'
import { schemas } from '../src/schemas.ts'
import { copyHistoricalInstances } from './fixtures.ts'

const configure = vi.fn(), credential = vi.fn()
const baseSha = 'a'.repeat(40), secret = 'test-only-credential-never-log'
const digest = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex')
let fixture: string, root: string, id: string, preview: Record<string, any>
let workflow: Workflow, store: Store
let endpoint: ReturnType<typeof createServer>
let github: RestGitHub
let calls: string[], forbidden: string[], bodies: Record<string, any>[]
let refs: Map<string, string>, trees: Map<string, TreeEntry[]>, commits: Map<string, any>, blobs: Map<string, string>
let onCredential: (() => Promise<void>) | undefined
let onRequest: ((route: string) => Promise<void>) | undefined
let prs: any[], checks: CheckRun[], remoteBase: string, failPR: boolean, corruptTree: boolean, failChecks: boolean, raceBase: boolean, echoSecret: boolean
const dir = () => join(root, 'examples/sample')
const proposalPath = () => join(dir(), 'proposals', `${id}.json`)
async function proposal() { return JSON.parse(await readFile(proposalPath(), 'utf8')) }
async function changeProposal(edit: (p: any) => void) { const p = await proposal(); edit(p); await writeFile(proposalPath(), JSON.stringify(p)) }
function submit(extra = {}) { return workflow.call('submit_change', { instance: 'sample', proposalId: id, expectedBaseSha: baseSha, ...extra }) }

beforeAll(async () => {
  fixture = registerTempDir(await mkdtemp(join(tmpdir(), 'wb-submit-fixture-')))
  await symlink(resolve('node_modules'), join(fixture, 'node_modules'))
  await writeFile(join(fixture, 'package.json'), '{"type":"module"}')
  await copyHistoricalInstances(fixture)
  await writeFile(join(fixture, 'examples/sample/package.json'), '{"type":"module"}')
  await writeFile(join(fixture, 'examples/sample/bun.lock'), 'lock snapshot')
  const s = new Store(join(fixture, 'examples/sample'), new Set(['sample'])); await s.init()
  const w = new Workflow(s)
  const proposed = await w.call('propose_change', { instance: 'sample', baseRevision: 2, changes: [{ kind: 'add_field', entity: 'jobs', field: 'submission_notes', definition: { type: 'text' } }] })
  id = String(proposed.proposalId)
  expect((await w.call('validate', { proposalId: id })).ok).toBe(true)
  preview = await w.call('preview_migration', { proposalId: id })
  expect((await w.call('apply_to_disposable', { proposalId: id })).verified).toBe(true)
  expect((await w.call('promote', { proposalId: id, expectedRevision: 2 })).ok).toBe(true)
})
afterAll(async () => { cleanupTempDir(fixture) })
beforeEach(async () => {
  root = registerTempDir(await mkdtemp(join(tmpdir(), 'wb-submit-')))
  await cp(fixture, root, { recursive: true, verbatimSymlinks: true })
  store = new Store(dir(), new Set(['sample'])); await store.init()
  calls = []; forbidden = []; bodies = []; prs = []; checks = []; onRequest = undefined; onCredential = undefined
  refs = new Map(); blobs = new Map(); trees = new Map([['base-tree', [{ path: 'README.md', mode: '100644', type: 'blob', sha: 'original-readme' }]]])
  commits = new Map([[baseSha, { tree: { sha: 'base-tree' }, parents: [] }]])
  remoteBase = baseSha; failPR = false; corruptTree = false; failChecks = false; raceBase = false; echoSecret = false
  endpoint = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost'), path = decodeURIComponent(url.pathname.replace('/repos/operator/instance', ''))
    const route = `${req.method} ${path}`
    calls.push(route)
    await onRequest?.(route)
    if (/merge|tags|release|deploy/.test(path)) forbidden.push(route)
    expect(req.headers.authorization).toBe(`Bearer ${secret}`)
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    if (body) bodies.push(body)
    const send = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (route === 'GET /git/ref/heads/main') { const sha = remoteBase; if (raceBase) remoteBase = 'b'.repeat(40); return send({ object: { sha } }) }
    if (req.method === 'GET' && path.startsWith('/git/ref/heads/')) { const sha = refs.get(path.slice('/git/ref/heads/'.length)); return sha ? send({ object: { sha } }) : send({}, 404) }
    if (req.method === 'GET' && path.startsWith('/git/commits/')) return send(commits.get(path.split('/').at(-1)!))
    if (req.method === 'GET' && path.startsWith('/git/trees/')) return send({ tree: trees.get(path.split('/').at(-1)!), truncated: false })
    if (route === 'POST /git/blobs') { const sha = digest(body); blobs.set(sha, body.content); return send({ sha }) }
    if (route === 'POST /git/trees') {
      const tree = new Map(trees.get(body.base_tree)!.map(e => [e.path, e]))
      for (const entry of body.tree) tree.set(entry.path, entry)
      if (corruptTree) tree.set('unrelated.txt', { path: 'unrelated.txt', mode: '100644', type: 'blob', sha: 'unexpected' })
      const entries = [...tree.values()], sha = digest(entries); trees.set(sha, entries); return send({ sha })
    }
    if (route === 'POST /git/commits') { const sha = digest(body); commits.set(sha, { tree: { sha: body.tree }, parents: body.parents.map((sha: string) => ({ sha })) }); return send({ sha }) }
    if (route === 'POST /git/refs') { const branch = body.ref.replace('refs/heads/', ''); if (refs.has(branch)) return send({}, 422); refs.set(branch, body.sha); return send({ ref: body.ref }) }
    if (route === 'GET /pulls') { expect(url.searchParams.get('state')).toBe('all'); expect(url.searchParams.get('head')).toBe(`operator:workbase/change-${id}`); return send(prs) }
    if (route === 'POST /pulls') {
      if (failPR) return send({ message: secret }, 503)
      const pr = { number: 17, html_url: echoSecret ? `https://example.test/${secret}` : 'https://github.com/operator/instance/pull/17', head: { sha: refs.get(body.head) }, base: { ref: body.base } }; prs.push(pr); return send(pr)
    }
    if (req.method === 'GET' && path.endsWith('/check-runs')) return failChecks ? send({ message: secret }, 503) : send({ check_runs: checks })
    forbidden.push(route); send({}, 500)
  })
  await new Promise<void>(r => endpoint.listen(0, '127.0.0.1', r))
  const address = endpoint.address() as { port: number }
  credential.mockReset().mockImplementation(async () => { await onCredential?.(); return secret })
  github = new RestGitHub('operator', 'instance', { credential }, `http://127.0.0.1:${address.port}`)
  configure.mockReset().mockImplementation(async instance => {
    expect(instance).toBe('sample')
    return { owner: 'operator', repository: 'instance', baseBranch: 'main', directory: 'config/sample', github }
  })
  workflow = new Workflow(store, configure)
})
afterEach(async () => {
  vi.restoreAllMocks()
  endpoint.closeAllConnections()
  await new Promise<void>((resolve, reject) => endpoint.close(e => e ? reject(e) : resolve()))
  expect(forbidden).toEqual([])
  expect(JSON.stringify(await proposal())).not.toContain(secret)
  expect(await readFile(join(dir(), 'proposals/log.jsonl'), 'utf8')).not.toContain(secret)
  cleanupTempDir(root)
})

describe('submit_change', () => {
  it('is registered with only the three strict inputs', () => {
    expect(Object.hasOwn(schemas, 'submit_change')).toBe(true)
    const schema = schemas.submit_change
    expect(schema.safeParse({ instance: 'sample', proposalId: id, expectedBaseSha: baseSha }).success).toBe(true)
    for (const extra of ['owner', 'repository', 'baseBranch', 'files', 'token']) expect(schema.safeParse({ instance: 'sample', proposalId: id, expectedBaseSha: baseSha, [extra]: 'forbidden' }).success).toBe(false)
  })
  it('opens exactly the promoted files, Czech preview SQL summary, immutable SHA and pending status; retry returns the same PR', async () => {
    const before = await readFile(proposalPath(), 'utf8')
    expect(await proposal()).not.toHaveProperty('kind')
    await writeFile(join(dir(), 'unrelated.txt'), 'do not submit')
    const first = await submit()
    expect(first).toMatchObject({ ok: true, prNumber: 17, prUrl: 'https://github.com/operator/instance/pull/17', checkState: 'pending', previewState: 'pending' })
    expect(String(first.headSha)).toMatch(/^[a-f0-9]{40}$/)
    const p = await proposal()
    expect(p.migrationPreview).toEqual({ sql: preview.sql, configDiff: preview.configDiff, revision: preview.revision })
    const tree = trees.get(commits.get(String(first.headSha)).tree.sha)!
    expect(tree.filter(e => e.path !== 'README.md').map(e => e.path).sort()).toEqual(p.promotedFiles.map((f: any) => `config/sample/${f.path}`).sort())
    for (const f of p.promotedFiles) expect(blobs.get(tree.find(e => e.path === `config/sample/${f.path}`)!.sha)).toBe(f.data)
    expect(tree.find(e => e.path === 'README.md')!.sha).toBe('original-readme')
    const body = bodies.find(b => b.title)!
    expect(body.body).toContain('Přidání pole: jobs / submission_notes'); expect(body.body).toContain('Shrnutí změny'); expect(body.body).toContain('Shrnutí migrace'); expect(body.body).toContain(preview.sql)
    expect(await submit()).toEqual(first)
    expect(await readFile(proposalPath(), 'utf8')).toBe(before)
    expect(calls.filter(c => c === 'POST /pulls')).toHaveLength(1)
    expect(calls.filter(c => c === 'POST /git/refs')).toHaveLength(1)
    expect(commits.get(String(first.headSha)).parents).toEqual([{ sha: baseSha }])
  })
  it('recovers a pushed branch after PR creation fails, without changing its head', async () => {
    failPR = true
    expect((await submit()).ok).toBe(false)
    const head = refs.get(`workbase/change-${id}`)
    expect(head).toBeDefined()
    failPR = false
    expect(await submit()).toMatchObject({ ok: true, headSha: head, prNumber: 17 })
    expect(calls.filter(c => c === 'POST /git/refs')).toHaveLength(1)
    expect(prs).toHaveLength(1)
  })
  it('recovers a PR created before reading checks failed and never creates another', async () => {
    failChecks = true; expect((await submit()).ok).toBe(false)
    failChecks = false; expect((await submit()).ok).toBe(true)
    expect(calls.filter(c => c === 'POST /pulls')).toHaveLength(1)
  })
  it.each(['proposed', 'validated', 'verified', 'discarded'])('rejects an unpromoted %s proposal before GitHub access', async status => {
    await changeProposal(p => { p.status = status })
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'promotion_required' } }); expect(calls).toEqual([])
  })
  it('rejects unknown proposals and mismatched instances', async () => {
    expect(await submit({ proposalId: crypto.randomUUID() })).toMatchObject({ ok: false, error: { code: 'proposal_not_found' } })
    expect(await submit({ instance: 'secondary' })).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })
  it.each(['missing', 'different'])('rejects %s verification proof', async kind => {
    await changeProposal(p => { if (kind === 'missing') delete p.verification; else p.verification.planHash = 'changed' })
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'verification_required' } }); expect(calls).toEqual([])
  })
  it('rejects stale base before writing remote objects', async () => {
    remoteBase = 'b'.repeat(40)
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'stale_base' } })
    expect(calls).toEqual(['GET /git/ref/heads/main'])
  })
  it('rejects base movement during preparation before publishing a branch', async () => {
    raceBase = true
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'stale_base' } }); expect(refs.size).toBe(0)
  })
  it('rejects any file outside the promoted set, even in a recomputed snapshot', async () => {
    await changeProposal(p => { p.promotedFiles.push({ path: '../secret', data: 'forbidden' }); p.promotionHash = promotionHash(p) })
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'file_not_allowed' } }); expect(calls).toEqual([])
  })
  it('rejects changed promoted file bytes', async () => {
    await writeFile(join(dir(), 'config.indexes.json'), '[]\n// changed')
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'promoted_files_changed' } }); expect(calls).toEqual([])
  })
  it('rejects a deleted promoted file with a Czech error before GitHub access', async () => {
    const p = await proposal()
    await rm(join(dir(), p.promotedFiles[0].path))
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'promoted_files_changed', message: 'Soubory povýšené změny byly změněny.' } })
    expect(calls).toEqual([])
  })
  it('rejects extra files returned by the remote tree', async () => {
    corruptTree = true
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'file_not_allowed' } }); expect(refs.size).toBe(0)
  })
  it('rejects changed branch heads rather than updating them', async () => {
    refs.set(`workbase/change-${id}`, 'c'.repeat(40))
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'submission_conflict' } }); expect(prs).toEqual([])
  })
  it('checks existing PR head and base and finds closed PRs too', async () => {
    expect((await submit()).ok).toBe(true)
    prs[0].head.sha = 'd'.repeat(40)
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'submission_conflict' } })
    expect(calls.filter(c => c === 'POST /pulls')).toHaveLength(1)
  })
  it.each(['success', 'failure', 'pending'])('returns %s checks and preview without waiting', async expected => {
    checks = [{ name: 'PR preview', status: expected === 'pending' ? 'in_progress' : 'completed', conclusion: expected === 'pending' ? null : expected, details_url: 'https://preview.example' }]
    expect(await submit()).toMatchObject({ ok: true, checkState: expected, previewState: expected })
  })
  it('returns a clear Czech error with the default operator configuration', async () => {
    workflow = new Workflow(store)
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'github_not_configured', message: expect.stringContaining('není nakonfigurován') } })
    expect(calls).toEqual([])
  })
  it('has only a not-configured production credential provider', async () => {
    expect(await notConfigured.credential()).toBeUndefined()
    github = new RestGitHub('operator', 'instance')
    await expect(github.ref('main')).rejects.toMatchObject({ code: 'github_not_configured', message: expect.stringContaining('není nakonfigurován') })
  })
  it('redacts provider and HTTP failure details from outputs, errors and audit logs', async () => {
    failPR = true
    const output = await submit(); expect(output.ok).toBe(false); expect(JSON.stringify(output)).not.toContain(secret)
    const broken = new RestGitHub('operator', 'instance', { async credential() { throw new Error(secret) } })
    await expect(broken.ref('main')).rejects.toMatchObject({ message: expect.not.stringContaining(secret) })
  })
  it('redacts credentials echoed in successful remote data', async () => {
    echoSecret = true
    const result = await submit()
    expect(result.ok).toBe(true)
    expect(result.prUrl).toBe('https://example.test/[REDACTED]')
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('rejects legacy promoted proposals without a captured snapshot', async () => {
    await changeProposal(p => { delete p.promotedFiles; delete p.promotionHash })
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'promotion_snapshot_required' } })
    expect(calls).toEqual([])
  })
  it('rejects a modified snapshot before GitHub access', async () => {
    await changeProposal(p => { p.promotedFiles[0].data += '\n-- unexpected' })
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'promotion_snapshot_required' } })
    expect(calls).toEqual([])
  })
  it('rejects multiple existing PRs and wrong PR bases without creating another PR', async () => {
    expect((await submit()).ok).toBe(true)
    prs[0].base.ref = 'wrong-base'
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'submission_conflict' } })
    prs.push({ ...prs[0], number: 18 })
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'submission_conflict' } })
    expect(calls.filter(c => c === 'POST /pulls')).toHaveLength(1)
  })

})

it.each(['package.json', 'bun.lock'])('rejects changed %s before GitHub, and restored bytes retain the same PR', async name => {
  const first = await submit()
  expect(first.ok).toBe(true)
  const path = join(dir(), name), before = await readFile(path)
  await writeFile(path, Buffer.concat([before, Buffer.from('\n')]))
  calls = []
  expect(await submit()).toMatchObject({ ok: false, error: { code: 'dependencies_changed', message: expect.stringContaining('znovu ověř') } })
  expect(calls).toEqual([])
  await writeFile(path, before)
  expect(await submit()).toEqual(first)
  expect(prs).toHaveLength(1)
})
it('rejects legacy standalone dependency evidence with an actionable Czech error', async () => {
  await changeProposal(p => { delete p.dependencyDigest; delete p.validation.dependencyDigest; delete p.verification.dependencyDigest; p.promotionHash = promotionHash(p) })
  expect(await submit()).toMatchObject({ ok: false, error: { code: 'dependency_snapshot_required', message: expect.stringContaining('nový návrh') } })
  expect(calls).toEqual([])
})
it.each(['package.json', 'bun.lock'])('rejects deleted or symlinked %s before GitHub access', async name => {
  const path = join(dir(), name)
  await rm(path)
  expect(await submit()).toMatchObject({ ok: false, error: { code: 'dependencies_changed' } })
  expect(calls).toEqual([])
  await symlink(join(fixture, 'examples/sample', name), path)
  expect(await submit()).toMatchObject({ ok: false, error: { code: 'unsafe_path' } })
  expect(calls).toEqual([])
})
it('keeps monorepo legacy submissions independent of standalone dependency evidence', async () => {
  await changeProposal(p => { delete p.dependencyDigest; delete p.validation.dependencyDigest; delete p.verification.dependencyDigest; p.promotionHash = promotionHash(p) })
  const monorepo = new Store(root, new Set(['sample'])); await monorepo.init()
  workflow = new Workflow(monorepo, async () => ({ owner: 'operator', repository: 'instance', baseBranch: 'main', directory: 'config/sample', github }))
  await writeFile(join(dir(), 'bun.lock'), 'changed')
  expect((await submit()).ok).toBe(true)
})
it('binds the separate dependency digest into the promotion hash', async () => {
  await changeProposal(p => { p.dependencyDigest = '0'.repeat(64) })
  expect(await submit()).toMatchObject({ ok: false, error: { code: 'promotion_snapshot_required' } })
  expect(calls).toEqual([])
})

it('rejects dependencies edited during configuration before any GitHub calls', async () => {
  workflow = new Workflow(store, async () => {
    await writeFile(join(dir(), 'bun.lock'), 'edited during configuration')
    return { owner: 'operator', repository: 'instance', baseBranch: 'main', directory: 'config/sample', github }
  })
  expect(await submit()).toMatchObject({ ok: false, error: { code: 'dependencies_changed', message: expect.stringContaining('znovu ověř') } })
  expect(calls).toEqual([])
  expect(refs.size).toBe(0)
  expect(prs).toEqual([])
})
it.each([
  'GET /git/commits/', 'POST /git/blobs', 'POST /git/trees', 'GET /git/trees/',
  'POST /git/commits', 'GET /git/ref/heads/workbase/', 'POST /git/refs', 'GET /pulls',
])('stops subsequent mutations after dependencies change during %s', async boundary => {
  let injectedAt = -1
  onRequest = async route => {
    if (injectedAt === -1 && route.startsWith(boundary)) {
      await writeFile(join(dir(), 'package.json'), '{"type":"module","edited":true}')
      injectedAt = calls.length
    }
  }
  expect(await submit()).toMatchObject({ ok: false, error: { code: 'dependencies_changed', message: expect.stringContaining('znovu ověř') } })
  expect(injectedAt).toBeGreaterThan(0)
  expect(calls.slice(injectedAt).filter(c => /^(POST|PATCH|PUT|DELETE) /.test(c))).toEqual([])
  if (!['POST /git/refs', 'GET /pulls'].includes(boundary)) expect(refs.size).toBe(0)
  expect(prs).toEqual([])
})

it.each(['package.json', 'bun.lock'].flatMap(name => ['first write', 'PR creation'].map(boundary => ({ name, boundary }))))('rejects $name edited during credential retrieval before $boundary reaches fetch', async ({ name, boundary }) => {
  let injected = false
  const writes: string[] = []
  const originalFetch = globalThis.fetch
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (injected && init?.method !== 'GET') writes.push(`${init?.method} ${input}`)
    return originalFetch(input, init)
  })
  onCredential = async () => {
    const previous = calls.at(-1)
    if (!injected && (boundary === 'first write' ? previous === `GET /git/commits/${baseSha}` : previous === 'GET /pulls')) {
      await writeFile(join(dir(), name), 'edited during credential retrieval')
      injected = true
    }
  }
  try {
    expect(await submit()).toMatchObject({ ok: false, error: { code: 'dependencies_changed', message: expect.stringContaining('znovu ověř') } })
    expect(injected).toBe(true)
    expect(writes).toEqual([])
    expect(calls).not.toContain('POST /pulls')
    if (boundary === 'first write') expect(calls.filter(c => !c.startsWith('GET '))).toEqual([])
    expect(prs).toEqual([])
  } finally { fetchStub.mockRestore() }
})

const seedUpgrade = async () => {
  const bundle = await store.load('sample')
  const p = {
    kind: 'sdk_upgrade', proposalId: id, instance: 'sample', baseRevision: bundle.config.revision,
    createdAt: '2026-11-08T12:00:00.000Z', status: 'proposed', targetVersion: '1.2.3',
    baseFingerprint: bundle.fingerprint, baseDependencyDigest: bundle.dependencyDigest,
  }
  await writeFile(proposalPath(), JSON.stringify(p))
  return p
}
it('inspects a seeded SDK upgrade without rewriting it and persists discard through storage', async () => {
  const p = await seedUpgrade(), before = await readFile(proposalPath(), 'utf8')
  expect(await workflow.call('inspect_schema', { instance: 'sample' })).toMatchObject({
    ok: true, pendingProposals: [{ proposalId: id, baseRevision: p.baseRevision, createdAt: p.createdAt, status: 'proposed' }],
  })
  expect(await readFile(proposalPath(), 'utf8')).toBe(before)
  expect(await workflow.call('discard', { proposalId: id })).toEqual({ ok: true, status: 'discarded' })
  expect(parseProposal(await proposal())).toEqual({ ...p, status: 'discarded' })
  const restarted = new Store(dir()); await restarted.init()
  expect(await new Workflow(restarted).call('inspect_schema', { instance: 'sample' })).toMatchObject({ ok: true, pendingProposals: [] })
  expect(configure).not.toHaveBeenCalled(); expect(credential).not.toHaveBeenCalled(); expect(calls).toEqual([])
})
it.each(['promote', 'submit_change'])('rejects SDK %s before config execution; spies observe a real config control', async action => {
  const original = await proposal()
  const p = await seedUpgrade(), before = await readFile(proposalPath(), 'utf8')
  const plan = vi.spyOn(planning, 'prepare'), guard = vi.spyOn(planning, 'guard')
  const apply = vi.spyOn(disposable, 'applyDisposable'), commit = vi.spyOn(store, 'commit')
  const input = { proposalId: id, ...(action === 'promote' ? { expectedRevision: p.baseRevision } : {}),
    ...(action === 'submit_change' ? { instance: 'sample', expectedBaseSha: baseSha } : {}) }
  for (const status of ['proposed', 'discarded']) {
    await writeFile(proposalPath(), JSON.stringify({ ...p, status }))
    expect(await workflow.call(action, input)).toMatchObject({ ok: false, error: {
      code: action === 'submit_change' ? 'sdk_upgrade_not_supported' : status === 'discarded' ? 'proposal_closed' : 'validation_required', status: 409,
    } })
    for (const spy of [plan, guard, apply, commit, configure, credential]) expect(spy).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(await readFile(proposalPath(), 'utf8')).toBe(JSON.stringify({ ...p, status }))
  }
  await writeFile(proposalPath(), before)
  // Exercise the same spies with a valid legacy config proposal. Each protected
  // boundary must actually be reachable; zero-call assertions alone are insufficient.
  let controlId = id
  if (action === 'submit_change') await writeFile(proposalPath(), JSON.stringify(original))
  else {
    const control = await workflow.call('propose_change', { instance: 'sample', baseRevision: p.baseRevision,
      changes: [{ kind: 'add_field', entity: 'jobs', field: 'control_notes', definition: { type: 'text' } }] })
    expect(control.ok).toBe(true); controlId = String(control.proposalId)
    expect(guard).toHaveBeenCalledOnce()
    const storedPath = join(dir(), 'proposals', `${controlId}.json`)
    const stored = JSON.parse(await readFile(storedPath, 'utf8'))
    expect(await readFile(storedPath, 'utf8')).toBe(json({
      proposalId: controlId, instance: 'sample', baseRevision: p.baseRevision,
      changes: [{ kind: 'add_field', entity: 'jobs', field: 'control_notes', definition: { type: 'text' } }],
      createdAt: stored.createdAt, status: 'proposed',
    }))
    if (['apply_to_disposable', 'promote'].includes(action)) expect((await workflow.call('validate', { proposalId: controlId })).ok).toBe(true)
    if (action === 'promote') expect((await workflow.call('apply_to_disposable', { proposalId: controlId })).ok).toBe(true)
  }
  for (const spy of [plan, guard, apply, commit, configure, credential]) spy.mockClear()
  expect((await workflow.call(action, { ...input, proposalId: controlId })).ok).toBe(true)
  if (action !== 'submit_change') expect(plan).toHaveBeenCalled()
  if (action === 'apply_to_disposable') expect(apply).toHaveBeenCalledOnce()
  if (action === 'promote') expect(commit).toHaveBeenCalledOnce()
  if (action === 'submit_change') {
    expect(configure).toHaveBeenCalled(); expect(credential).toHaveBeenCalled(); expect(calls.length).toBeGreaterThan(0)
  }
})
