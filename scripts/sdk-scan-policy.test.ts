import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { reviewDigest } from './lib/private-terms'
import policy from './sdk-scan-policy.json'

// This exact-byte check must run even when private scan vocabulary is unavailable.
it('preserves all three exact-line bun.lock scan reviews', () => {
  const lines = readFileSync(new URL('../bun.lock', import.meta.url), 'utf8').split('\n')
  const reviews = policy.terms.filter(review => review.pathDigest === reviewDigest('bun.lock'))
  expect(reviews).toHaveLength(3)
  for (const review of reviews) expect(reviewDigest(lines[review.lineNumber - 1]), `bun.lock:${review.lineNumber}`).toBe(review.lineDigest)
})

it('preserves every exact-line scan review independently of private vocabulary', () => {
  const root = resolve(import.meta.dirname, '..')
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const pathByDigest = new Map(paths.map(path => [reviewDigest(path), path]))
  for (const review of policy.terms) {
    const path = pathByDigest.get(review.pathDigest)
    expect(path).toBeDefined()
    const lines = readFileSync(resolve(root, path!), 'utf8').split('\n')
    expect(reviewDigest(lines[review.lineNumber - 1]), `${path}:${review.lineNumber}`).toBe(review.lineDigest)
  }
})
