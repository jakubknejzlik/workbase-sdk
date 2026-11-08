import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import type { InstanceConfig } from '@workbasehq/core/config'
import { defineInstance } from '@workbasehq/core/config'
import { samplePlugin, secondaryPlugin, tertiaryPlugin, quaternaryPlugin } from './model'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fail } from '../../src/schemas.ts'

const source = pathToFileURL(resolve(import.meta.dirname, 'model.ts')).href
export const sources: Record<string, { factory: () => WorkbasePlugin; exported: string; source: string }> = {
  sample: { factory: samplePlugin, exported: 'samplePlugin', source },
  secondary: { factory: secondaryPlugin, exported: 'secondaryPlugin', source },
  tertiary: { factory: tertiaryPlugin, exported: 'tertiaryPlugin', source },
  quaternary: { factory: quaternaryPlugin, exported: 'quaternaryPlugin', source },
}
export const allowed = Object.keys(sources)
export function protectedField(config: InstanceConfig, entity: string, field: string, rename: boolean) {
  const routeFields: Record<string, string[]> = config.commands.includes('bookings/create')
    ? { clients: ['name'], workers: ['name'], jobs: ['client_id'], slots: ['job_id', 'worker_id'] } : {}
  return (entity === 'slots' && ['capacity', 'booked'].includes(field)) ||
    (entity === 'bookings' && ['status', 'slot_id', 'client_id'].includes(field)) || (rename && routeFields[entity]?.includes(field))
}

export const agentInstance = 'disposable-sample-agent'
export async function createAgentInstance(root: string) {
  const { configSource, json, noLink } = await import('../../src/storage.ts')
  const { hash } = await import('../../src/planning.ts')
  const { hydratePlugins } = await import('../../src/template.ts')
  const template = join(root, 'packages/mcp/test/fixtures/template')
  const destination = join(root, 'examples', agentInstance)
  await noLink(join(root, 'examples'), true); await mkdir(join(root, 'examples'), { recursive: true }); await noLink(destination, true)
  try {
    await noLink(join(destination, '.mcp-template.json'))
    const marker = JSON.parse(await readFile(join(destination, '.mcp-template.json'), 'utf8'))
    if (marker.createdBy !== 'workbase-mcp' || marker.template !== 'sample-v3' || marker.initialRevision !== 3) fail('invalid_template', 'Existing disposable has no valid server creation marker', 409)
    return agentInstance
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  // Never replace a caller-created or unfinished instance directory.
  try { await readdir(destination); fail('instance_exists', 'Disposable directory already exists without a creation marker', 409) }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const stage = join(root, 'examples', `.mcp-template-${crypto.randomUUID()}`)
  await mkdir(join(stage, 'migrations'), { recursive: true })
  try {
    const templateConfig = JSON.parse(await readFile(join(template, 'config.json'), 'utf8'))
    const input = { ...templateConfig }
    // Fixed JSON templates contain only public contract descriptors. Hydrate
    // exact canonical descriptors here, before validation; arbitrary config
    // source serialization must never turn a same-name substitute into code.
    input.plugins = await hydratePlugins(input.plugins)
    const config = defineInstance(input)
    await writeFile(join(stage, 'config.ts'), configSource(config))
    const migrations: { name: string; sql: string }[] = []
    for (const name of (await readdir(join(template, 'migrations'))).sort()) {
      if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) fail('invalid_template', 'Invalid template migration')
      const sql = await readFile(join(template, 'migrations', name), 'utf8')
      migrations.push({ name, sql }); await writeFile(join(stage, 'migrations', name), sql)
    }
    await writeFile(join(stage, '.mcp-template.json'), json({ createdBy: 'workbase-mcp', template: 'sample-v3',
      initialRevision: config.revision, initialHash: hash({ config: templateConfig, migrations }), createdAt: new Date().toISOString() }))
    await rename(stage, destination)
    return agentInstance
  } finally { await rm(stage, { recursive: true, force: true }) }
}
