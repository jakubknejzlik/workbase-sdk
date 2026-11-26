import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { reviewDigest } from './lib/private-terms'
import policy from './sdk-scan-policy.json'

it.each([
  'packages/core/src/asset.ts',
  'packages/plugins/console/assets/index.js',
  'scripts/check-console-public.test.ts',
])('fails closed on malformed encoded data in %s', async path => {
  const { assertBytes, withPolicyDataReviews } = await import('./lib/sdk-export-scan')
  const malformedUri = ['data:text/plain,', '%ZZ'].join('')
  const content = Buffer.from(`const asset = ${JSON.stringify(malformedUri)}`)
  expect(() => assertBytes(path, content, withPolicyDataReviews(policy))).toThrow(`unscannable encoded asset: ${path}`)
})

it('scans the test source that builds the same malformed URI at runtime', async () => {
  const { assertBytes, withPolicyDataReviews } = await import('./lib/sdk-export-scan')
  const path = 'scripts/check-console-public.test.ts'
  const source = readFileSync(new URL('../' + path, import.meta.url))
  expect(source.toString('utf8')).not.toContain(['data:text/plain,', '%ZZ'].join(''))
  expect(() => assertBytes(path, source, withPolicyDataReviews(policy))).not.toThrow()
})

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

it('every literal exact-line review matches its source line', () => {
  const root = resolve(import.meta.dirname, '..')
  const paths = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))
  for (const category of ['ids', 'emails', 'encoded', 'hostLiterals'] as const) {
    for (const [index, review] of (policy[category] ?? []).entries()) {
      const location = `${category}[${index}] ${review.path}:${review.lineNumber}`
      expect.soft(paths.has(review.path), location).toBe(true)
      expect.soft(Number.isInteger(review.lineNumber) && review.lineNumber > 0, location).toBe(true)
      expect.soft(review.reason.trim(), location).not.toBe('')
      if (!paths.has(review.path) || !Number.isInteger(review.lineNumber) || review.lineNumber < 1) continue
      const lines = readFileSync(resolve(root, review.path), 'utf8').split('\n')
      expect.soft(review.lineNumber <= lines.length, location).toBe(true)
      if (review.lineNumber > lines.length) continue
      expect.soft(lines[review.lineNumber - 1], location).toBe(review.line)
    }
  }
})

it('accepts only the exact upstream Alata at its source and packed identities', async () => {
  const { assertBytes, alataSourcePath, alataPackedPath, alataPublicPath, withPolicyDataReviews } = await import('./lib/sdk-export-scan')
  const bytes = readFileSync(resolve(import.meta.dirname, '..', alataSourcePath))
  const reviewed = withPolicyDataReviews(policy)
  for (const path of [alataSourcePath, alataPackedPath, alataPublicPath]) {
    expect(() => assertBytes(path, bytes, reviewed)).not.toThrow()
    const mutation = Buffer.from(bytes); mutation[mutation.length - 1] ^= 1
    expect(() => assertBytes(path, mutation, reviewed)).toThrow('integrity')
    expect(() => assertBytes(path, Buffer.from([0, 1, 2, 3]), reviewed)).toThrow('integrity')
  }
  for (const path of ['packages/ui/src/assets/fonts/Other.ttf', 'packages/plugins/console/assets/Alata-Regular.ttf', 'assets/Alata-Regular.ttf']) {
    expect(() => assertBytes(path, bytes, reviewed)).toThrow('binary/encoded asset')
  }
  expect(() => assertBytes('packages/core/src/unrelated.bin', Buffer.from([0, 1, 2, 3]), reviewed)).toThrow('binary/encoded asset')
})
