import { afterEach, expect, it } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from '../src/server.ts'
import type { TreeEntry } from '../src/github.ts'
import { provisionLocalSdk } from './fixtures/local-sdk.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const baseSha = 'a'.repeat(40), secret = 'synthetic-stdio-token-never-echo'
const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex')
async function scratch() { const root = await realpath(await mkdtemp(join(tmpdir(), 'stdio-github-'))); roots.push(root); return root }
async function fixture() {
  const root = await scratch()
  const app = await createServer({ root })
  try {
    expect(await app.workflow.call('bootstrap_instance', { id: 'example', target: 'cloudflare-github' })).toMatchObject({ ok: true })
    await provisionLocalSdk(root)
    // Reuse installed UI peers for the scaffold; no test performs a package install.
    for (const directory of ['node_modules', 'packages/plugins/node_modules', 'packages/frontend-console/node_modules']) {
      for (const name of await readdir(resolve(directory))) {
        if (name.startsWith('.')) continue
        const names = name.startsWith('@') ? (await readdir(resolve(directory, name))).map(child => `${name}/${child}`) : [name]
        for (const name of names) {
          await mkdir(join(root, 'node_modules', name, '..'), { recursive: true })
          await symlink(resolve(directory, name), join(root, 'node_modules', name)).catch(error => { if (error.code !== 'EEXIST') throw error })
        }
      }
    }
    const preview = await app.workflow.call('initialize_instance', { instance: 'example', mode: 'preview' })
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true })
    expect(await app.workflow.call('initialize_instance', { instance: 'example', mode: 'apply', planHash: preview.planHash })).toMatchObject({ ok: true })
  } finally { await app.server.close() }
  return root
}
async function session(root: string, runtime: string, env: Record<string, string> = {}, hook?: string) {
  const client = new Client({ name: 'example', version: '1' })
  const transport = new StdioClientTransport({ command: runtime, args: [
    ...(runtime === 'bun' ? ['--no-install', ...(hook ? ['--preload', hook] : [])] : [...(hook ? ['--import', pathToFileURL(hook).href] : []), '--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]),
    resolve('packages/mcp/src/stdio.ts'), '--root', root,
  ], stderr: 'pipe', env: { ...process.env, WORKBASE_GITHUB_TARGET: '', TMPDIR: tmpdir(), ...env } as Record<string, string> })
  let stderr = ''
  transport.stderr?.on('data', data => { stderr += data.toString() })
  const responses: unknown[] = []
  try { await client.connect(transport) } catch (error) { await transport.close(); throw new Error(`${String(error)} ${stderr}`) }
  return { responses, stderr: () => stderr, call: async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
    responses.push(response)
    return response.structuredContent as any
  }, close: async () => { await client.close(); await transport.close() } }
}
async function promoted(call: Awaited<ReturnType<typeof session>>['call']) {
  const proposed = await call('propose_composition', { instance: 'example', baseRevision: 1, changes: [{ kind: 'set_instance_display_name', displayName: 'Alex Example' }] })
  expect(proposed).toMatchObject({ ok: true, kind: 'composition_change' })
  const { proposalId } = proposed
  const validation = await call('validate', { proposalId })
  expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true })
  expect(await call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
  expect(await call('promote', { proposalId, expectedRevision: 1 })).toMatchObject({ ok: true })
  return { instance: 'example', proposalId, expectedBaseSha: baseSha }
}
async function diskText(root: string): Promise<string> {
  let text = ''
  for (const name of await readdir(root)) {
    if (name === 'node_modules') continue
    const path = join(root, name)
    const stat = await lstat(path)
    if (stat.isDirectory()) text += await diskText(path)
    else if (stat.isFile()) text += await readFile(path, 'utf8')
  }
  return text
}
it.each([['bun', 'token-file'], ['node', 'token-file'], ['bun', 'github-app'], ['node', 'github-app']])('submits a verified promoted composition through real %s stdio with %s and only one branch, commit and PR', async (runtime, credentialType) => {
  const root = await fixture(), operator = await scratch()
  const requests: { method: string; path: string; body: any }[] = []
  const unexpected: string[] = []
  const refs = new Map<string, string>()
  const trees = new Map<string, TreeEntry[]>([['base-tree', []]])
  const commits = new Map([[baseSha, { tree: { sha: 'base-tree' } }]])
  const prs: any[] = []
  let mintCount = 0, fail = false
  let jwt = ''
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const endpoint = createHttpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    const url = new URL(req.url!, 'http://localhost')
    const path = decodeURIComponent(url.pathname)
    requests.push({ method: req.method!, path, body })
    const send = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (path === '/app/installations/2/access_tokens' && req.method === 'POST') {
      jwt = req.headers.authorization?.slice(7) ?? ''
      const [header, payload, signature] = jwt.split('.')
      if (!signature || !verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))) { unexpected.push('invalid JWT'); return send({}, 401) }
      mintCount++
      return send({ token: secret, expires_at: new Date(Date.now() + 3600000).toISOString() })
    }
    if (req.headers.authorization !== `Bearer ${secret}` || !path.startsWith('/repos/example/example/')) { unexpected.push(path); return send({}, 401) }
    const route = `${req.method} ${path.slice('/repos/example/example'.length)}`
    if (fail) return send({ message: secret }, 503)
    if (route === 'GET /git/ref/heads/integration/preview') return send({ object: { sha: baseSha } })
    if (route.startsWith('GET /git/ref/heads/')) { const sha = refs.get(path.slice('/repos/example/example/git/ref/heads/'.length)); return sha ? send({ object: { sha } }) : send({}, 404) }
    if (route.startsWith('GET /git/commits/')) return send(commits.get(path.split('/').at(-1)!))
    if (route.startsWith('GET /git/trees/')) return send({ tree: trees.get(path.split('/').at(-1)!), truncated: false })
    if (route === 'POST /git/blobs') return send({ sha: hash(body) })
    if (route === 'POST /git/trees') { const sha = hash(body); trees.set(sha, body.tree); return send({ sha }) }
    if (route === 'POST /git/commits') { const sha = hash(body); commits.set(sha, { tree: { sha: body.tree } }); return send({ sha }) }
    if (route === 'POST /git/refs') { refs.set(body.ref.replace('refs/heads/', ''), body.sha); return send({ ref: body.ref }) }
    if (route === 'GET /pulls') return send(prs)
    if (route === 'POST /pulls') { const pr = { html_url: `https://example.test/pull/1?echo=${secret}`, number: 1, head: { sha: refs.get(body.head) }, base: { ref: body.base } }; prs.push(pr); return send(pr) }
    if (route.endsWith('/check-runs') && req.method === 'GET') return send({ check_runs: [] })
    unexpected.push(route); return send({}, 500)
  })
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`
  // Intercept the production HTTPS origin in the child; no endpoint selection is added to env/config/tools.
  const hook = join(operator, 'fake-fetch.mjs')
  await writeFile(hook, `const original = globalThis.fetch; globalThis.fetch = (input, init) => { const url = new URL(String(input)); if (url.origin !== 'https://api.github.com') throw new Error('Unexpected test origin'); return original(${JSON.stringify(address)} + url.pathname + url.search, init) };\n`)
  await writeFile(join(operator, 'credential'), credentialType === 'token-file' ? secret : privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const config = join(operator, 'target.json')
  await writeFile(config, JSON.stringify({ owner: 'example', repository: 'example', baseBranch: 'integration/preview', directory: 'instances/example', credential: credentialType === 'token-file' ? { type: 'token-file', path: join(operator, 'credential') } : { type: 'github-app', appId: 1, installationId: 2, privateKeyPath: join(operator, 'credential') } }))
  let child: Awaited<ReturnType<typeof session>> | undefined
  try {
    child = await session(root, runtime, { WORKBASE_GITHUB_TARGET: config }, hook)
    const args = await promoted(child.call)
    expect(String(args.proposalId)).toMatch(/^[0-9a-f-]{36}$/)
    for (const override of ['owner', 'repository', 'directory', 'path', 'credential', 'token', 'baseBranch', 'github']) {
      expect(await child.call('submit_change', { ...args, [override]: 'forbidden' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    }
    expect(requests).toEqual([])
    const result = await child.call('submit_change', args)
    expect(result).toMatchObject({ ok: true, prUrl: 'https://example.test/pull/1?echo=[REDACTED]', prNumber: 1, checkState: 'pending' })
    expect([...refs.keys()]).toEqual([`workbase/change-${args.proposalId}`])
    expect(requests.filter(r => r.method === 'POST' && r.path.endsWith('/git/commits'))).toHaveLength(1)
    expect(requests.filter(r => r.method === 'POST' && r.path.endsWith('/git/refs'))).toHaveLength(1)
    expect(requests.filter(r => r.method === 'POST' && r.path.endsWith('/pulls'))).toHaveLength(1)
    const entries = requests.find(r => r.method === 'POST' && r.path.endsWith('/git/trees'))!.body.tree as TreeEntry[]
    expect(entries.every(entry => entry.path.startsWith('instances/example/'))).toBe(true)
    expect(requests.find(r => r.method === 'POST' && r.path.endsWith('/pulls'))!.body.base).toBe('integration/preview')
    fail = true
    expect(await child.call('submit_change', args)).toMatchObject({ ok: false, error: { code: 'github_unavailable' } })
    const observed = JSON.stringify(child.responses) + child.stderr() + await diskText(root)
    expect(observed).not.toContain(secret)
    if (jwt) expect(observed).not.toContain(jwt)
    expect(observed).not.toContain(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    expect(unexpected).toEqual([])
    expect(requests.some(r => /merge|tags|releases|deployments/.test(r.path))).toBe(false)
    expect(mintCount).toBe(credentialType === 'github-app' ? 1 : 0)
  } finally {
    await child?.close()
    endpoint.closeAllConnections()
    await new Promise<void>(resolve => endpoint.close(() => resolve()))
  }
})
it.each(['bun', 'node'])('keeps github_not_configured for a promoted composition in %s without env configuration', async runtime => {
  const root = await fixture()
  // Stdio's transport otherwise inherits this task's environment; explicitly remove the target.
  const hookRoot = await scratch(), hook = join(hookRoot, 'unset-target.mjs')
  await writeFile(hook, 'delete process.env.WORKBASE_GITHUB_TARGET\n')
  const child = await session(root, runtime, {}, hook)
  try {
    const args = await promoted(child.call)
    expect(await child.call('submit_change', args)).toMatchObject({ ok: false, error: { code: 'github_not_configured' } })
  } finally { await child.close() }
})
it.each(['bun', 'node'])('sanitizes invalid operator configuration even with WORKBASE_DEBUG under %s', async runtime => {
  const root = await scratch(), path = join(root, 'invalid.json')
  await writeFile(path, secret)
  const child = spawn(runtime, [...(runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]), resolve('packages/mcp/src/stdio.ts'), '--root', root], { env: { ...process.env, TMPDIR: tmpdir(), WORKBASE_GITHUB_TARGET: path, WORKBASE_DEBUG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  expect(await new Promise(resolve => child.on('exit', resolve))).toBe(1)
  expect(output).toContain('invalid_github_config')
  expect(output).not.toContain(secret)
})
