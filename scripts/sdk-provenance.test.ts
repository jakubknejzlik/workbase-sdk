import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSdkArchives, assertSdkPackageNames } from './sdk-provenance'

const expected = ['@workbasehq/core', '@workbasehq/plugins', '@workbasehq/mcp']
test('requires exactly the three SDK manifest identities, regardless of order', () => {
  assert.doesNotThrow(() => assertSdkPackageNames([...expected].reverse()))
  for (const names of [[], expected.slice(1), [...expected, '@workbasehq/ui'], [expected[0], expected[0], expected[2]], [expected[0], expected[1], '@workbasehq/ui']]) {
    assert.throws(() => assertSdkPackageNames(names), /expected exactly SDK packages/)
  }
})

test('packer archive assertion reads manifest identities and rejects extra, missing or substituted archives', () => {
  const root = registerTempDir(mkdtempSync(join(tmpdir(), 'sdk-archives-')))
  const directory = join(root, 'dist-sdk')
  try {
    mkdirSync(directory)
    mkdirSync(join(root, 'package'))
    const pack = (file: string, name: string) => {
      writeFileSync(join(root, 'package/package.json'), JSON.stringify({ name }))
      execFileSync('tar', ['-czf', join(directory, file), '-C', root, 'package'])
    }
    expected.forEach((name, index) => pack(`${index}.tgz`, name))
    assert.doesNotThrow(() => assertSdkArchives(directory))
    pack('extra.tgz', '@workbasehq/ui')
    assert.throws(() => assertSdkArchives(directory), /expected exactly SDK packages/)
    rmSync(join(directory, 'extra.tgz'))
    rmSync(join(directory, '2.tgz'))
    assert.throws(() => assertSdkArchives(directory), /expected exactly SDK packages/)
    pack('2.tgz', '@workbasehq/core')
    assert.throws(() => assertSdkArchives(directory), /expected exactly SDK packages/)
    pack('2.tgz', '@workbasehq/ui')
    assert.throws(() => assertSdkArchives(directory), /expected exactly SDK packages/)
  } finally { cleanupTempDir(root) }
})
