import { readFileSync } from 'node:fs'

const ZERO = /^0{40}$/

/**
 * Base ref for `check:schema` linkage.
 * - pull_request: the target branch tip.
 * - push (CI): the pre-push tip from the event payload, so every pushed commit is checked
 *   against the state it replaced; a new ref or unreadable payload falls back to HEAD^.
 *   Never HEAD itself: comparing a tree with itself accepts edited base migrations.
 * - local: origin/main.
 */
export function schemaBase(env: NodeJS.ProcessEnv = process.env, readEvent = (path: string) => readFileSync(path, 'utf8')): string {
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`
  if (!env.CI) return 'origin/main'
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_EVENT_PATH) {
    let before: unknown
    try { before = (JSON.parse(readEvent(env.GITHUB_EVENT_PATH)) as { before?: unknown }).before } catch { /* fall back */ }
    if (typeof before === 'string' && /^[0-9a-f]{40}$/.test(before) && !ZERO.test(before)) return before
  }
  return 'HEAD^'
}
