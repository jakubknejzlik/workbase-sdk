import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
export const scratchRoot = '/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-233-s1-impl-wr-87bdd668'
export const output = resolve(process.env.LIST_V2_OUTPUT ?? join(scratchRoot, 'list-v2-acceptance'))
const repository = resolve(import.meta.dirname, '../../..')
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
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))) })
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  record('captures', `${scenario}-${width}`, { scenario, referenceAsset: reference, capturePath: path, viewport: page.viewportSize(), locale: 'en', fullPage: true, injection: injection ?? null, provenance: 'provenance.run' })
}
export function result(info: TestInfo) {
  record('checks', info.title, { status: info.status, expectedStatus: info.expectedStatus, errors: info.errors.map(error => error.message), tracePath: info.outputPath('trace.zip'), attachments: info.attachments.map(({ name, path }) => ({ name, path })) })
}
