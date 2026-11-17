import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
test('full pack requires the live Worker/D1 browser proof and both workflows install pinned Chromium', () => {
  const pack = readFileSync('scripts/sdk-pack.sh', 'utf8')
  const config = 'packages/plugins/console/ui/test/browser/vitest.config.ts'
  expect(pack.indexOf(config)).toBeGreaterThan(pack.lastIndexOf('if [[ "$pack_only" == false ]]'))
  expect(pack.indexOf(config)).toBeLessThan(pack.indexOf('bun "$root/scripts/sdk-smoke.ts"'))
  for (const workflow of ['ci', 'release']) {
    const source = readFileSync('.github/workflows/' + workflow + '.yml', 'utf8')
    const install = source.indexOf('- run: bun x --no-install playwright install --with-deps chromium')
    expect(install).toBeGreaterThan(source.indexOf('- run: bun install --frozen-lockfile'))
    expect(install).toBeLessThan(source.indexOf('- run: bash scripts/sdk-pack.sh'))
  }
  const browser = readFileSync('packages/plugins/console/ui/test/browser/acceptance.test.ts', 'utf8')
  expect(browser).toContain('unstable_dev('); expect(browser).toContain('chromium.launch(')
  expect(browser).toContain("'/auth/sign-in/magic-link'"); expect(browser).not.toContain('Bearer ')
})
