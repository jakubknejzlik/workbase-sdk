import { createPrivateKey, sign } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, parse, sep } from 'node:path'
import { z } from 'zod'
import { RestGitHub, type GitHubConfiguration, type GitHubCredentialProvider } from './github.ts'
import { fail, WorkflowError } from './schemas.ts'

const absolutePath = z.string().min(1).refine(path => isAbsolute(path) && !path.includes('\0') && !path.split(sep).includes('..'))
const id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9][0-9]*$/)]).transform(String)
const directory = z.string().refine(value => value === '' || (/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) && !value.split('/').some(s => s === '.' || s === '..')))
const schema = z.strictObject({
  owner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/),
  repository: z.string().regex(/^[a-zA-Z0-9_.-]+$/).refine(value => value !== '.' && value !== '..'),
  baseBranch: z.string().min(1).refine(value => !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && value !== '@' && !value.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock'))),
  directory: directory.default(''),
  credential: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('token-file'), path: absolutePath }),
    z.strictObject({ type: z.literal('github-app'), appId: id, installationId: id, privateKeyPath: absolutePath }),
  ]),
})

/** Check every ancestor before opening, then inspect the opened file itself. Never expose paths or file bytes in errors. */
async function readOperatorFile(path: string, secret = false) {
  let handle
  try {
    let component = parse(path).root
    const parts = path.slice(component.length).split(sep).filter(Boolean)
    for (const [index, part] of parts.entries()) {
      component += (component.endsWith(sep) ? '' : sep) + part
      const stat = await lstat(component)
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail('unsafe_github_path', 'GitHub operator files must be regular files with no symlinked path components.')
    }
    // NONBLOCK also prevents a substituted FIFO from blocking startup or a tool call.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile()) fail('unsafe_github_path', 'GitHub operator files must be regular files with no symlinked path components.')
    if (secret && (stat.mode & 0o044)) fail('insecure_github_credential_permissions', 'GitHub token/key files must not be group or world readable; use mode 0600.')
    return await handle.readFile('utf8')
  } catch (error) {
    if (error instanceof WorkflowError) throw error
    fail('github_config_unreadable', 'Cannot safely read a GitHub operator file. Check its path and permissions.')
  } finally { await handle?.close() }
}
async function readToken(path: string) {
  const token = (await readOperatorFile(path, true)).trim()
  if (!/^[\x21-\x7e]+$/.test(token)) fail('invalid_github_credential', 'GitHub token file must contain a nonempty token.')
  return token
}
async function readKey(path: string) {
  const pem = await readOperatorFile(path, true)
  try {
    const key = createPrivateKey(pem)
    if (key.asymmetricKeyType !== 'rsa') throw new Error()
    return key
  } catch { fail('invalid_github_credential', 'GitHub App key file must contain an RSA private key.') }
}

class AppCredentials implements GitHubCredentialProvider {
  private cached?: { token: string; expires: number }
  private pending?: Promise<string>
  constructor(private config: { appId: string; installationId: string; privateKeyPath: string }, private endpoint: string, private now: () => number) {}
  async credential() {
    if (this.cached && this.now() < this.cached.expires - 300000) return this.cached.token
    // Share the mint among concurrent requests; a rejected mint is always retryable.
    this.pending ??= this.mint().finally(() => { this.pending = undefined })
    return this.pending
  }
  private async mint() {
    try {
      const key = await readKey(this.config.privateKeyPath)
      const seconds = Math.floor(this.now() / 1000)
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: this.config.appId })}`
      const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`
      const response = await fetch(`${this.endpoint}/app/installations/${this.config.installationId}/access_tokens`, {
        method: 'POST', redirect: 'error', headers: {
          authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        },
      })
      if (!response.ok) throw new Error()
      const data: unknown = await response.json()
      const result = z.object({ token: z.string().regex(/^[\x21-\x7e]+$/), expires_at: z.iso.datetime({ offset: true }) }).parse(data)
      const expires = Date.parse(result.expires_at)
      if (expires <= this.now() + 300000) throw new Error()
      this.cached = { token: result.token, expires }
      return result.token
    } catch {
      // Includes crypto, filesystem, transport and GitHub errors; none may leak credential bytes or the JWT.
      fail('github_unavailable', 'Cannot obtain GitHub App installation access. Check the operator configuration.', 503)
    }
  }
}

/** Only stdio's operator environment selects the file; endpoint/clock are in-process test seams, never tool inputs. */
export async function loadGitHubTarget(path: string | undefined, isAllowed: (instance: string) => boolean, options: { endpoint?: string; now?: () => number } = {}): Promise<GitHubConfiguration | undefined> {
  if (path === undefined) return undefined
  if (!absolutePath.safeParse(path).success) fail('invalid_github_config', 'WORKBASE_GITHUB_TARGET must be an absolute filesystem path without parent traversal.')
  const source = await readOperatorFile(path)
  let config: z.infer<typeof schema>
  try { config = schema.parse(JSON.parse(source)) }
  catch { fail('invalid_github_config', 'GitHub target configuration does not match the strict operator schema.') }
  const endpoint = options.endpoint ?? 'https://api.github.com'
  let credentials: GitHubCredentialProvider
  if (config.credential.type === 'token-file') {
    const { path } = config.credential
    await readToken(path)
    credentials = { credential: () => readToken(path) }
  } else {
    await readKey(config.credential.privateKeyPath)
    credentials = new AppCredentials(config.credential, endpoint, options.now ?? Date.now)
  }
  const { owner, repository, baseBranch, directory } = config
  const github = new RestGitHub(owner, repository, credentials, endpoint)
  return async instance => isAllowed(instance) ? { owner, repository, baseBranch, directory, github } : undefined
}
