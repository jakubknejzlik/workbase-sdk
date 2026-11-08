import { fail } from './schemas.ts'

/** Operator-owned capability. Credentials never enter tool arguments or persisted state. */
export interface GitHubCredentialProvider { credential(): Promise<string | undefined> }
export const notConfigured: GitHubCredentialProvider = { async credential() { return undefined } }
export type PullRequest = { html_url: string; number: number; head: { sha: string }; base: { ref: string } }
export type CheckRun = { name: string; status: string; conclusion: string | null; details_url: string | null }
export type TreeEntry = { path: string; mode: string; type: string; sha: string }
export type PreSendGuard = () => Promise<void>
export interface GitHub {
  ref(branch: string): Promise<string | undefined>
  commit(sha: string): Promise<{ tree: { sha: string }; parents: { sha: string }[] }>
  tree(sha: string): Promise<TreeEntry[]>
  createBlob(content: string, guard?: PreSendGuard): Promise<string>
  createTree(base: string, entries: TreeEntry[], guard?: PreSendGuard): Promise<string>
  createCommit(tree: string, parent: string, message: string, date: string, guard?: PreSendGuard): Promise<string>
  createRef(branch: string, sha: string, guard?: PreSendGuard): Promise<void>
  updateRef(branch: string, sha: string, guard?: PreSendGuard): Promise<void>
  findPullRequests(branch: string): Promise<PullRequest[]>
  createPullRequest(branch: string, base: string, title: string, body: string, guard?: PreSendGuard): Promise<PullRequest>
  checks(sha: string): Promise<CheckRun[]>
}
export type GitHubTarget = { owner: string; repository: string; baseBranch: string; directory: string; github: GitHub }
export type GitHubConfiguration = (instance: string) => Promise<GitHubTarget | undefined>

/** Small REST adapter: deliberately exposes no merge, tag, release or deployment API. */
export class RestGitHub implements GitHub {
  private repositoryUrl: string
  constructor(private owner: string, repository: string, private credentials: GitHubCredentialProvider = notConfigured, endpoint = 'https://api.github.com') {
    this.repositoryUrl = `${endpoint}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
  }
  private async request<T>(method: string, path: string, body?: unknown, missing = false, guard?: PreSendGuard): Promise<T> {
    // Never propagate provider, transport or remote response text: any can contain credentials.
    let credential: string | undefined
    try { credential = await this.credentials.credential() }
    catch { fail('github_unavailable', 'Přístup ke GitHubu se nepodařilo získat. Obraťte se na provozovatele.', 503) }
    if (!credential) fail('github_not_configured', 'Přístup ke GitHubu není nakonfigurován. Obraťte se na provozovatele.', 503)
    const url = this.repositoryUrl + path
    const request: RequestInit = { method, redirect: 'error', headers: {
      authorization: `Bearer ${credential}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
    // Fence against stale proofs, not atomic: hash-to-fetch races are accepted; dependency files are outside the allowlist.
    if (method !== 'GET') await guard?.()
    try {
      const response = await fetch(url, request)
      if (missing && response.status === 404) return undefined as T
      if (!response.ok) throw new Error('GitHub request failed')
      const data = await response.json()
      return JSON.parse(JSON.stringify(data).replaceAll(JSON.stringify(credential).slice(1, -1), '[REDACTED]')) as T
    } catch {
      fail('github_unavailable', 'GitHub není dostupný nebo přístup není nakonfigurován. Ověřte nastavení u provozovatele a zkuste požadavek znovu.', 503)
    }
  }
  async ref(branch: string) { return (await this.request<{ object: { sha: string } } | undefined>('GET', `/git/ref/heads/${encodeURIComponent(branch)}`, undefined, true))?.object.sha }
  commit(sha: string) { return this.request<{ tree: { sha: string }; parents: { sha: string }[] }>('GET', `/git/commits/${encodeURIComponent(sha)}`) }
  async tree(sha: string) {
    const result = await this.request<{ tree: TreeEntry[]; truncated: boolean }>('GET', `/git/trees/${encodeURIComponent(sha)}?recursive=1`)
    if (result.truncated) fail('github_tree_truncated', 'Úplný obsah větve nelze ověřit.', 409)
    return result.tree
  }
  async createBlob(content: string, guard?: PreSendGuard) { return (await this.request<{ sha: string }>('POST', '/git/blobs', { content, encoding: 'utf-8' }, false, guard)).sha }
  async createTree(base: string, entries: TreeEntry[], guard?: PreSendGuard) { return (await this.request<{ sha: string }>('POST', '/git/trees', { base_tree: base, tree: entries }, false, guard)).sha }
  async createCommit(tree: string, parent: string, message: string, date: string, guard?: PreSendGuard) {
    const identity = { name: 'Workbase', email: 'workbase@users.noreply.github.com', date }
    return (await this.request<{ sha: string }>('POST', '/git/commits', { tree, parents: [parent], message, author: identity, committer: identity }, false, guard)).sha
  }
  async createRef(branch: string, sha: string, guard?: PreSendGuard) { await this.request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha }, false, guard) }
  async updateRef(branch: string, sha: string, guard?: PreSendGuard) { await this.request('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false }, false, guard) }
  findPullRequests(branch: string) { return this.request<PullRequest[]>('GET', `/pulls?state=all&head=${encodeURIComponent(`${this.owner}:${branch}`)}&per_page=100`) }
  createPullRequest(branch: string, base: string, title: string, body: string, guard?: PreSendGuard) { return this.request<PullRequest>('POST', '/pulls', { head: branch, base, title, body }, false, guard) }
  async checks(sha: string) {
    const checks: CheckRun[] = []
    for (let page = 1; ; page++) {
      const result = await this.request<{ check_runs: CheckRun[] }>('GET', `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&page=${page}`)
      checks.push(...result.check_runs)
      if (result.check_runs.length < 100) return checks
    }
  }
}
