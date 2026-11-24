import { afterEach, beforeEach, expect, it } from 'vitest'
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root: string
let endpoint: ReturnType<typeof createServer> | undefined
const secret = 'synthetic-token-do-not-echo'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
let now = Date.parse('2026-11-24T20:00:00Z')
const target = () => ({ owner: 'example', repository: 'example', baseBranch: 'integration/preview', credential: { type: 'token-file', path: join(root, 'token') } })
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'github-target-')))
  await writeFile(join(root, 'token'), secret + '\n', { mode: 0o600 })
  await writeFile(join(root, 'key'), key, { mode: 0o600 })
  now = Date.parse('2026-11-24T20:00:00Z')
})
afterEach(async () => {
  endpoint?.closeAllConnections()
  if (endpoint) await new Promise<void>(resolve => endpoint!.close(() => resolve()))
  endpoint = undefined
  await rm(root, { recursive: true, force: true })
})
async function load(value: unknown = target(), path = join(root, 'target.json'), options = {}) {
  await writeFile(path, JSON.stringify(value))
  const { loadGitHubTarget } = await import('../src/github-target.ts')
  return (await loadGitHubTarget(path, instance => instance === 'example', options))!
}
async function fake(handler: RequestListener) {
  endpoint = createServer(handler)
  await new Promise<void>(resolve => endpoint!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`
}
it('defaults the directory and only answers for the operator allowed instance', async () => {
  const configure = await load()
  expect(await configure('unknown')).toBeUndefined()
  expect(await configure('example')).toMatchObject({ owner: 'example', repository: 'example', baseBranch: 'integration/preview', directory: '' })
})
it('leaves absent configuration undefined', async () => {
  const { loadGitHubTarget } = await import('../src/github-target.ts')
  expect(await loadGitHubTarget(undefined, () => true)).toBeUndefined()
})
it.each([
  ['unknown property', () => ({ ...target(), token: secret })],
  ['credential unknown property', () => ({ ...target(), credential: { ...target().credential, token: secret } })],
  ['missing repository', () => ({ ...target(), repository: undefined })],
  ['empty owner', () => ({ ...target(), owner: '' })],
  ['path owner', () => ({ ...target(), owner: '../example' })],
  ['invalid branch', () => ({ ...target(), baseBranch: 'bad\nbranch' })],
  ['empty branch', () => ({ ...target(), baseBranch: '' })],
  ['relative token', () => ({ ...target(), credential: { type: 'token-file', path: 'token' } })],
  ['inline token', () => ({ ...target(), credential: { type: 'token', token: secret } })],
  ['relative key', () => ({ ...target(), credential: { type: 'github-app', appId: 1, installationId: 2, privateKeyPath: 'key' } })],
  ['invalid App ID', () => ({ ...target(), credential: { type: 'github-app', appId: -1, installationId: 2, privateKeyPath: join(root, 'key') } })],
  ['absolute directory', () => ({ ...target(), directory: '/example' })],
  ['traversal directory', () => ({ ...target(), directory: 'example/../other' })],
  ['dot directory', () => ({ ...target(), directory: '.' })],
  ['empty component', () => ({ ...target(), directory: 'example//other' })],
] as const)('rejects %s without echoing input', async (_name, value) => {
  await expect(load(value())).rejects.toMatchObject({ code: 'invalid_github_config' })
  await load(value()).catch(error => expect(String(error)).not.toContain(secret))
})
it('rejects relative config paths and malformed JSON with sanitized errors', async () => {
  const { loadGitHubTarget } = await import('../src/github-target.ts')
  await expect(loadGitHubTarget('target.json', () => true)).rejects.toMatchObject({ code: 'invalid_github_config' })
  await writeFile(join(root, 'invalid'), secret)
  await expect(loadGitHubTarget(join(root, 'invalid'), () => true)).rejects.toMatchObject({ code: 'invalid_github_config' })
})
it.each(['config', 'token', 'key'])('rejects final and ancestor symlinks for %s', async kind => {
  const value = kind === 'key' ? { ...target(), credential: { type: 'github-app', appId: 1, installationId: 2, privateKeyPath: join(root, 'key') } } : target()
  await writeFile(join(root, 'target.json'), JSON.stringify(value))
  const { loadGitHubTarget } = await import('../src/github-target.ts')
  await symlink(root, join(root, 'linked'))
  const withAncestor = kind === 'config' ? value : { ...value, credential: { ...value.credential, [kind === 'key' ? 'privateKeyPath' : 'path']: join(root, 'linked', kind) } }
  if (kind !== 'config') await writeFile(join(root, 'target.json'), JSON.stringify(withAncestor))
  await expect(loadGitHubTarget(join(root, kind === 'config' ? 'linked/target.json' : 'target.json'), () => true)).rejects.toMatchObject({ code: 'unsafe_github_path' })
  await symlink(join(root, kind === 'config' ? 'target.json' : kind), join(root, 'link'))
  if (kind !== 'config') await writeFile(join(root, 'target.json'), JSON.stringify({ ...value, credential: { ...value.credential, [kind === 'key' ? 'privateKeyPath' : 'path']: join(root, 'link') } }))
  await expect(loadGitHubTarget(join(root, kind === 'config' ? 'link' : 'target.json'), () => true)).rejects.toMatchObject({ code: 'unsafe_github_path' })
})
it.each(['config', 'token', 'key'])('requires a regular %s file', async kind => {
  const { loadGitHubTarget } = await import('../src/github-target.ts')
  if (kind === 'config') await expect(loadGitHubTarget(root, () => true)).rejects.toMatchObject({ code: 'unsafe_github_path' })
  else await expect(load({ ...target(), credential: kind === 'token' ? { type: 'token-file', path: root } : { type: 'github-app', appId: 1, installationId: 2, privateKeyPath: root } })).rejects.toMatchObject({ code: 'unsafe_github_path' })
})
it.each([0o640, 0o604, 0o644])('rejects token/key permissions %s', async mode => {
  for (const name of ['token', 'key']) {
    await chmod(join(root, name), mode)
    await expect(load({ ...target(), credential: name === 'token' ? target().credential : { type: 'github-app', appId: 1, installationId: 2, privateKeyPath: join(root, 'key') } })).rejects.toMatchObject({ code: 'insecure_github_credential_permissions' })
  }
})
it('reads token files per request, rechecks safety, and redacts remote responses and failures', async () => {
  let responseStatus = 200, expectedToken = secret
  const endpoint = await fake((req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${expectedToken}`)
    res.writeHead(responseStatus, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: { sha: expectedToken }, message: expectedToken }))
  })
  const configure = await load(target(), undefined, { endpoint })
  const github = (await configure('example'))!.github
  expect(await github.ref('integration/preview')).toBe('[REDACTED]')
  expectedToken = 'synthetic-rotated-token'
  await writeFile(join(root, 'token'), expectedToken)
  expect(await github.ref('integration/preview')).toBe('[REDACTED]')
  responseStatus = 503
  await expect(github.ref('integration/preview')).rejects.toMatchObject({ code: 'github_unavailable' })
  await chmod(join(root, 'token'), 0o644)
  await expect(github.ref('integration/preview')).rejects.toMatchObject({ code: 'github_unavailable' })
  await github.ref('integration/preview').catch(error => expect(String(error)).not.toContain(secret))
})
it('mints RS256 App tokens, caches concurrent requests, refreshes five minutes early and redacts', async () => {
  let minted = 0
  const endpoint = await fake(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/app/installations/2/access_tokens') {
      expect(req.method).toBe('POST')
      expect(req.headers['x-github-api-version']).toBe('2022-11-28')
      const jwt = req.headers.authorization!.slice('Bearer '.length)
      const [header, payload, signature] = jwt.split('.')
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ iss: '1', iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540 })
      minted++
      return res.end(JSON.stringify({ token: secret, expires_at: new Date(now + 3600000).toISOString() }))
    }
    expect(req.headers.authorization).toBe(`Bearer ${secret}`)
    res.end(JSON.stringify({ object: { sha: secret } }))
  })
  const configure = await load({ ...target(), directory: 'config/example', credential: { type: 'github-app', appId: 1, installationId: '2', privateKeyPath: join(root, 'key') } }, undefined, { endpoint, now: () => now })
  const github = (await configure('example'))!.github
  expect(await Promise.all([github.ref('a'), github.ref('b')])).toEqual(['[REDACTED]', '[REDACTED]'])
  expect(minted).toBe(1)
  now += 55 * 60000 - 1
  await github.ref('a'); expect(minted).toBe(1)
  now++
  await github.ref('a'); expect(minted).toBe(2)
})
it.each(['status', 'transport', 'invalid-json', 'missing-token', 'expired', 'invalid-expiry', 'near-expiry', 'redirect'])('sanitizes App %s failures', async failure => {
  const endpoint = await fake((_req, res) => {
    if (failure === 'transport') return res.destroy(new Error(secret))
    res.writeHead(failure === 'status' ? 401 : failure === 'redirect' ? 302 : 200, { 'content-type': 'application/json', location: '/unexpected' })
    res.end(failure === 'invalid-json' ? secret : JSON.stringify({ token: failure === 'missing-token' ? undefined : secret, expires_at: failure === 'invalid-expiry' ? secret : new Date(now + (failure === 'expired' ? -1 : failure === 'near-expiry' ? 60000 : 3600000)).toISOString(), message: secret }))
  })
  const configure = await load({ ...target(), credential: { type: 'github-app', appId: 1, installationId: 2, privateKeyPath: join(root, 'key') } }, undefined, { endpoint, now: () => now })
  const github = (await configure('example'))!.github
  await expect(github.ref('a')).rejects.toMatchObject({ code: 'github_unavailable' })
  await github.ref('a').catch(error => expect(String(error)).not.toContain(secret))
})
it('rejects empty tokens and invalid RSA keys without echoing their bytes', async () => {
  await writeFile(join(root, 'token'), '\n')
  await expect(load()).rejects.toMatchObject({ code: 'invalid_github_credential' })
  await writeFile(join(root, 'key'), secret)
  await expect(load({ ...target(), credential: { type: 'github-app', appId: 1, installationId: 2, privateKeyPath: join(root, 'key') } })).rejects.toMatchObject({ code: 'invalid_github_credential' })
})

it.each(['config', 'token', 'key'])('sanitizes unreadable %s files', async kind => {
  const { loadGitHubTarget } = await import('../src/github-target.ts')
  if (kind === 'config') await expect(loadGitHubTarget(join(root, 'missing'), () => true)).rejects.toMatchObject({ code: 'github_config_unreadable' })
  else await expect(load({ ...target(), credential: kind === 'token' ? { type: 'token-file', path: join(root, 'missing') } : { type: 'github-app', appId: 1, installationId: 2, privateKeyPath: join(root, 'missing') } })).rejects.toMatchObject({ code: 'github_config_unreadable' })
})
it('accepts owner-read-only credentials and rejects a symlink substituted after startup', async () => {
  await chmod(join(root, 'token'), 0o400)
  const configure = await load()
  await rm(join(root, 'token'))
  await symlink(join(root, 'key'), join(root, 'token'))
  await expect((await configure('example'))!.github.ref('a')).rejects.toMatchObject({ code: 'github_unavailable' })
})
it('rejects non-RSA App keys', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  await writeFile(join(root, 'key'), privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await expect(load({ ...target(), credential: { type: 'github-app', appId: 1, installationId: 2, privateKeyPath: join(root, 'key') } })).rejects.toMatchObject({ code: 'invalid_github_credential' })
})
