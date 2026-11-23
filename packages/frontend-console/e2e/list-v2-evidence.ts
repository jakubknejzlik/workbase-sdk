import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, relative } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
export const scratchRoot = tmpdir()
export const output = resolve(process.env.LIST_V2_OUTPUT ?? mkdtempSync(join(scratchRoot, 'list-v2-acceptance-')))
const repository = resolve(import.meta.dirname, '../../..')
if (!relative(repository, output).startsWith('..')) throw new Error('LIST_V2_OUTPUT must be outside the repository')
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
function assetHash(directory: string): string {
  return hash(readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => entry.isDirectory() ? `${entry.name}:${assetHash(join(directory, entry.name))}` : `${entry.name}:${hash(readFileSync(join(directory, entry.name)))}`).join('\n'))
}
export function record(section: string, key: string, value: unknown) {
  mkdirSync(output, { recursive: true })
  const path = join(output, 'manifest.json')
  let manifest: Record<string, any> = {}
  try { manifest = JSON.parse(readFileSync(path, 'utf8')) } catch {}
  manifest[section] = { ...manifest[section], [key]: value }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
}
export function provenance(browserVersion: string) {
  record('provenance', 'run', {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    workingTreeDiffSha256: hash(execFileSync('git', ['diff', 'HEAD'], { cwd: repository })),
    buildSha256: assetHash(join(repository, 'packages/frontend-console/dist')), browserVersion,
    referenceZipSha256: 'f95b87d93e814b41f1d8856b1063b9bb1b23237cb9147a2145dd7194e167a2f0',
    fixtureSha256: assetHash(join(repository, 'packages/frontend-console/e2e/runtime')),
    locale: 'en', generatedRoute: '/o/org-a/e/worker',
  })
}
export async function capture(page: Page, scenario: string, reference: string, injection?: string) {
  const width = page.viewportSize()!.width
  const path = join(output, `en-${width}-${scenario}.png`)
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))) })
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  record('captures', `${scenario}-${width}`, { scenario, referenceAsset: reference, referenceScenario: scenario, capturePath: path, viewport: page.viewportSize(), locale: 'en', fullPage: true, injection: injection ?? null, ...JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')).provenance.run })
}
export function result(info: TestInfo, failure?: unknown) {
  record('checks', info.title, { status: failure ? 'failed' : info.status, expectedStatus: info.expectedStatus, errors: [...info.errors.map(error => error.message), ...(failure ? [failure instanceof Error ? failure.message : String(failure)] : [])], tracePath: info.status === 'passed' && !failure ? null : info.outputPath('trace.zip'), attachments: info.attachments.map(({ name, path }) => ({ name, path })) })
}

/** SDK review evidence, captured in the acceptance run that proves the source. */
export async function captureSDK(page: Page, state: string, locale: 'en' | 'cs', info: TestInfo) {
  const viewport = page.viewportSize()!
  const path = join(output, `SDK-${locale}-${viewport.width}x${viewport.height}-${state}.png`)
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))) })
  await page.screenshot({ path, animations: 'disabled' })
  const display = await page.evaluate(() => ({ DPR: devicePixelRatio, rootFontSize: getComputedStyle(document.documentElement).fontSize }))
  record('SDK', path.split('/').at(-1)!, { label: 'SDK', state, locale, viewport, ...display, sourceSHA: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), spec: info.file.split('/').at(-1), test: info.title, path })
}
