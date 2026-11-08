import { execFileSync } from 'node:child_process'

interface StagingRun {
  head_sha: string
  head_branch: string
  event: string
  conclusion: string | null
  path: string
}
const dependencies = {
  git: (args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  fetch: (url: string, init: RequestInit) => fetch(url, init),
}
/** Fail closed before SST reads state; never substitute current main for the release SHA. */
export async function verifyRelease(env: NodeJS.ProcessEnv = process.env, deps = dependencies): Promise<string> {
  const ref = env.GITHUB_REF ?? ''
  const repository = env.GITHUB_REPOSITORY ?? ''
  if (!/^refs\/tags\/v[^\s]+$/.test(ref) || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !env.GITHUB_TOKEN) {
    throw Error('Vydání vyžaduje tag v*, GITHUB_REPOSITORY a GITHUB_TOKEN.')
  }
  const sha = deps.git(['rev-parse', `${ref}^{commit}`])
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Tag neodkazuje na platný commit.')
  if (deps.git(['rev-parse', 'HEAD']) !== sha) throw Error('Checkout neodpovídá SHA release tagu.')
  try {
    deps.git(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
    deps.git(['merge-base', '--is-ancestor', sha, 'origin/main'])
  } catch { throw Error(`Commit ${sha} není dosažitelný z main; Production nebyla spuštěna.`) }
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ head_sha: sha, branch: 'main', event: 'push', per_page: '100', page: String(page) })
    const response = await deps.fetch(`https://api.github.com/repos/${repository}/actions/workflows/staging.yml/runs?${query}`, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    })
    if (!response.ok) throw Error(`GitHub API: nelze ověřit Staging (HTTP ${response.status}).`)
    const { workflow_runs: runs } = await response.json() as { workflow_runs: StagingRun[] }
    if (!Array.isArray(runs)) throw Error('GitHub API: chybí seznam běhů Staging.')
    if (runs.some(run => run.path === '.github/workflows/staging.yml' && run.head_sha === sha &&
      run.head_branch === 'main' && run.event === 'push' && run.conclusion === 'success')) return sha
    if (runs.length < 100) break
  }
  throw Error(`Chybí úspěšný push běh Staging (staging.yml, main) pro commit ${sha}; Production nebyla spuštěna.`)
}
if (import.meta.main) {
  try { console.log(await verifyRelease()) }
  catch (error) { console.error(`Ověření vydání selhalo: ${(error as Error).message}`); process.exitCode = 1 }
}
