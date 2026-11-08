import { expect, it, vi } from 'vitest'
import { verifyRelease } from '../templates/standalone/scripts/release-guard'

const sha = 'a'.repeat(40)
const main = 'b'.repeat(40)
const env = { GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_REPOSITORY: 'owner/instance', GITHUB_TOKEN: 'test-token' }
const good = { head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success', path: '.github/workflows/staging.yml' }
function fixture(runs: unknown[] = [good]) {
  const git = vi.fn((args: string[]) => {
    if (args[0] === 'rev-parse') return args[1] === 'origin/main' ? main : sha
    return ''
  })
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ workflow_runs: runs })))
  return { git, fetch }
}
it('accepts the exact green Staging SHA even after main advances, and peels annotated tags', async () => {
  const deps = fixture()
  expect(await verifyRelease(env, deps)).toBe(sha)
  expect(deps.git).toHaveBeenCalledWith(['rev-parse', 'refs/tags/v1.2.3^{commit}'])
  expect(deps.git).toHaveBeenCalledWith(['merge-base', '--is-ancestor', sha, 'origin/main'])
  expect(deps.fetch.mock.calls[0][0]).toContain('/actions/workflows/staging.yml/runs?')
  const url = new URL(deps.fetch.mock.calls[0][0])
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ head_sha: sha, branch: 'main', event: 'push', per_page: '100' })
})
it.each([
  ['missing', []], ['pending', [{ ...good, conclusion: null }]],
  ['failed', [{ ...good, conclusion: 'failure' }]],
  ['wrong workflow', [{ ...good, path: '.github/workflows/ci.yml' }]],
  ['wrong branch', [{ ...good, head_branch: 'topic' }]],
  ['wrong SHA', [{ ...good, head_sha: main }]],
  ['manual dispatch', [{ ...good, event: 'workflow_dispatch' }]],
])('rejects %s Staging evidence', async (_name, runs) => {
  await expect(verifyRelease(env, fixture(runs))).rejects.toThrow('Chybí úspěšný push běh Staging')
})
it('rejects a SHA outside main before querying GitHub', async () => {
  const deps = fixture()
  deps.git.mockImplementation(args => { if (args[0] === 'merge-base') throw Error('not ancestor'); return sha })
  await expect(verifyRelease(env, deps)).rejects.toThrow('není dosažitelný z main')
  expect(deps.fetch).not.toHaveBeenCalled()
})
it('rejects checkout of a different SHA', async () => {
  const deps = fixture()
  deps.git.mockImplementation(args => args[1] === 'HEAD' ? main : sha)
  await expect(verifyRelease(env, deps)).rejects.toThrow('Checkout neodpovídá')
})
it('fails closed on API errors and paginates Staging history', async () => {
  const deps = fixture()
  deps.fetch.mockResolvedValueOnce(new Response('denied', { status: 403 }))
  await expect(verifyRelease(env, deps)).rejects.toThrow('GitHub API')
  deps.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: Array(100).fill({ ...good, conclusion: null }) })))
  expect(await verifyRelease(env, deps)).toBe(sha)
  expect(deps.fetch.mock.calls.at(-1)?.[0]).toContain('page=2')
})
it.each([{ ...env, GITHUB_REF: 'refs/heads/main' }, { ...env, GITHUB_TOKEN: '' }, { ...env, GITHUB_REPOSITORY: '' }])('rejects invalid release context', async context => {
  await expect(verifyRelease(context, fixture())).rejects.toThrow('Vydání vyžaduje')
})
