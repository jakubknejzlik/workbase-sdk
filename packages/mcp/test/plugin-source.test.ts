import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { expect, it } from 'vitest'
import { quaternary } from './fixtures/model'
import { sample } from './fixtures/model'
import { tertiary } from './fixtures/model'
import { secondary } from './fixtures/model'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { identity } from '@workbasehq/plugins/identity'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { serializableInstanceConfig } from '../../core/src/config'
import { KernelRegistry } from '../../core/src/kernel/registry'
import { createAgentInstance } from '../src/template'
import { configSource } from '../src/storage'

async function roundTrip(config: typeof sample) {
  const dir = registerTempDir(await mkdtemp(join(process.cwd(), '.plugin-source-')))
  try {
    const path = join(dir, 'config.ts')
    await writeFile(path, configSource(config))
    return (await tsImport(pathToFileURL(path).href, import.meta.url)).default as typeof sample
  } finally { cleanupTempDir(dir) }
}
it('F2 preserves canonical source provenance across isolated source round trips', async () => {
  const result = await roundTrip(sample)
  expect(new KernelRegistry(result).permissionsActive).toBe(true)
  expect(() => configSource(result)).not.toThrow()
})
it('F2 refuses same-name descriptors that would enable permissions after a round trip', async () => {
  const input = { ...sample, interactive: false, plugins: [{ name: 'rbac', version: '0.1.0' }] }
  expect(new KernelRegistry(input).permissionsActive).toBe(false)
  await expect(roundTrip(input)).rejects.toMatchObject({ code: 'unsupported_plugin_source' })
})
it.each([
  { ...rbac, commandGuard: () => ({ allow: false as const, code: 'restricted' }) },
  { ...identity, authenticate: () => null },
])('F2 refuses modified same-name hooks: $name', async substitute => {
  await expect(roundTrip({ ...sample, plugins: [substitute] })).rejects.toMatchObject({ code: 'unsupported_plugin_source' })
})

it('F2 refuses a template descriptor missing its canonical permissions contract', async () => {
  const dir = registerTempDir(await mkdtemp(join(process.cwd(), '.plugin-source-')))
  try {
    await mkdir(join(dir, 'instances'))
    await mkdir(join(dir, 'packages/mcp/templates'), { recursive: true })
    await cp('packages/mcp/test/fixtures/template', join(dir, 'packages/mcp/test/fixtures/template'), { recursive: true })
    const path = join(dir, 'packages/mcp/test/fixtures/template/config.json')
    const template = JSON.parse(await readFile(path, 'utf8'))
    delete template.plugins.find((plugin: { name: string }) => plugin.name === 'permissions').provides
    await writeFile(path, JSON.stringify(template))
    await expect(createAgentInstance(dir)).rejects.toMatchObject({ code: 'invalid_template' })
  } finally { cleanupTempDir(dir) }
})

it.each([
  { name: 'quaternary', config: quaternary, minimumCommands: 11 },
  { name: 'sample', config: sample, minimumCommands: 7 },
  { name: 'tertiary', config: tertiary, minimumCommands: 7 },
  { name: 'secondary', config: secondary, minimumCommands: 1 },
])('round trips the $name domain factory with its executable contributions', async ({name, config, minimumCommands}) => {
  const result = await roundTrip(config)
  const kernel = new KernelRegistry(result)
  expect(kernel.plugins.some(plugin => plugin.name === name)).toBe(true)
  expect(config.commands.length).toBeGreaterThan(0)
  expect(config.commands.length).toBeGreaterThanOrEqual(minimumCommands)
  for (const command of config.commands) expect(kernel.commands.has(command)).toBe(true)
  expect(serializableInstanceConfig(result).entities).toEqual(serializableInstanceConfig(config).entities)
  expect(result.ui).toEqual(config.ui)
  expect(result.plugins!.map(plugin => plugin.configuration)).toEqual(config.plugins!.map(plugin => plugin.configuration))
  const source = configSource(result)
  expect(source).toContain('identity({')
  expect(source).toContain('members()')
  expect(source).toContain('organizations({')
  expect(source).toContain('localAuth({')
})
it('rejects a copied domain descriptor and freezes canonical domain model data', () => {
  const domain = sample.plugins!.find(plugin => plugin.name === 'sample')!
  expect(Object.isFrozen(domain.model!.entities!.jobs.fields.title)).toBe(true)
  expect(() => configSource({ ...sample, plugins: sample.plugins!.map(plugin => plugin === domain ? { ...plugin } : plugin) })).toThrow(/noncanonical/)
})
it('refuses a template that changes a factory configuration without changing its canonical descriptor', async () => {
  const dir = registerTempDir(await mkdtemp(join(process.cwd(), '.plugin-source-')))
  try {
    await mkdir(join(dir, 'instances'))
    await mkdir(join(dir, 'packages/mcp/templates'), { recursive: true })
    await cp('packages/mcp/test/fixtures/template', join(dir, 'packages/mcp/test/fixtures/template'), { recursive: true })
    const path = join(dir, 'packages/mcp/test/fixtures/template/config.json')
    const template = JSON.parse(await readFile(path, 'utf8'))
    template.plugins.find((plugin: { name: string }) => plugin.name === 'local-auth').configuration = { methods: ['password'] }
    await writeFile(path, JSON.stringify(template))
    await expect(createAgentInstance(dir)).rejects.toThrow()
  } finally { cleanupTempDir(dir) }
})

it('preserves configured Identity trust and Organizations options through source materialization', async () => {
  const input = { ...sample, plugins: sample.plugins!.map(plugin => plugin.name === 'identity'
    ? createIdentity({ trustedIssuers: { 'https://idp.example.test': ['example.test'] } })
    : plugin.name === 'organizations' ? createOrganizations({ allowCreate: false }) : plugin) }
  const result = new KernelRegistry(await roundTrip(input))
  expect(result.config.pluginConfig?.identity).toEqual({ trustedIssuers: { 'https://idp.example.test': ['example.test'] } })
  expect(result.config.pluginConfig?.organizations).toEqual({ allowCreate: false })
})
