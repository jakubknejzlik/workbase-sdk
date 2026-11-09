import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { verifySdkInstalled } from '../src/sdk-integrity'
import { registryFixture } from './fixtures/sdk-registry'

let fixture: Awaited<ReturnType<typeof registryFixture>>
beforeEach(async () => { fixture = await registryFixture() })
afterEach(async () => { await fixture.close() })
const verify = () => verifySdkInstalled(fixture.root, process.env, fixture.archives)

it('compares raw binary bytes and the complete deterministic file set', async () => {
  const first = await verify()
  expect(first.status).toBe('pass')
  expect(first.packages.map(pkg => pkg.files)).toEqual([2, 2, 2])
  expect(await verify()).toEqual(first)
})
it.each(['changed', 'extra', 'missing', 'symlink', 'package-link', 'nested'])('rejects changed installed files: %s', async mode => {
  const directory = join(fixture.root, 'node_modules/@workbasehq/core'), binary = join(directory, 'binary.dat')
  if (mode === 'changed') await writeFile(binary, Buffer.from([0xff, 0xfe, 0, 2]))
  if (mode === 'extra') await writeFile(join(directory, 'extra'), 'extra')
  if (mode === 'missing') await rm(binary)
  if (mode === 'symlink') { const bytes = await readFile(binary); await writeFile(join(fixture.base, 'binary'), bytes); await rm(binary); await symlink(join(fixture.base, 'binary'), binary) }
  if (mode === 'package-link') { await rm(directory, { recursive: true }); await symlink(join(fixture.base, 'core/package'), directory) }
  if (mode === 'nested') { await mkdir(join(directory, 'node_modules/@workbasehq/core'), { recursive: true }); await writeFile(join(directory, 'node_modules/@workbasehq/core/package.json'), '{}') }
  await expect(verify()).rejects.toThrow()
})
it('rejects a symlink substituted for an archive', async () => {
  const archive = join(fixture.archives, 'core.tgz'), bytes = await readFile(archive), target = join(fixture.base, 'substitute.tgz')
  await writeFile(target, bytes); await rm(archive); await symlink(target, archive)
  await expect(verify()).rejects.toThrow()
})
