import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, test, vi } from 'vitest'
// This artifact-shape probe does not certify the private-vocabulary scan.
// The normal pack gate still runs the real scan and requires its real secret.
vi.mock('../../../../../scripts/check-console-public', () => ({ checkConsolePublic: vi.fn(() => 'Synthetic asset scan') }))
import { stageConsolePackage } from '../../../../../scripts/lib/stage-console-package'
test('producer staging and the resulting tarball retain React/Vite exports and all auth modules', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'workbase-auth-pack-')), root = join(scratch, 'root'), stage = join(scratch, 'stage'), archives = join(scratch, 'archives')
  function put(name: string, value: string) { const file = join(root, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, value) }
  try {
    const manifest = JSON.parse(readFileSync(resolve('packages/plugins/package.json'), 'utf8'))
    put('packages/plugins/package.json', JSON.stringify(manifest)); put('packages/plugins/NOTICE', 'Synthetic notice'); put('LICENSE', 'Synthetic license')
    put('packages/plugins/console/src/index.ts', 'export {}')
    put('packages/plugins/console/assets/build-meta.json', JSON.stringify({ version: manifest.version }))
    cpSync(resolve('packages/plugins/console/ui/src'), join(root, 'packages/plugins/console/ui/src'), { recursive: true })
    cpSync(resolve('packages/plugins/console/ui/README.md'), join(root, 'packages/plugins/console/ui/README.md'))
    stageConsolePackage(root, 'plugins', stage); mkdirSync(archives)
    const packed = spawnSync('bun', ['pm', 'pack', '--destination', archives, '--quiet'], { cwd: stage, encoding: 'utf8' })
    expect(packed.status, packed.stderr).toBe(0)
    const archive = join(archives, readdirSync(archives).find(file => file.endsWith('.tgz'))!)
    const member = (name: string) => { const result = spawnSync('tar', ['-xOf', archive, 'package/' + name], { encoding: 'utf8' }); expect(result.status, result.stderr).toBe(0); return result.stdout }
    const installed = JSON.parse(member('package.json'))
    const react = installed.exports['./console/ui/react'].replace(/^\.\//, ''), vite = installed.exports['./console/ui/vite'].replace(/^\.\//, '')
    expect(member(react)).toContain('AuthShell'); expect(member(react)).toContain('useAuthDirty'); expect(member(vite)).toContain('resolveBuildSHA')
    for (const name of ['auth-shell', 'auth-dirty']) expect(member('console/ui/src/react/' + name + '.ts')).toBeTruthy()
    for (const name of ['build-reload', 'auth-storage']) expect(member('console/ui/src/' + name + '.ts')).toBeTruthy()
    expect(member('console/ui/README.md')).toContain('AuthShell')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
