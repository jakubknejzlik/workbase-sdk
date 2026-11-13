import { mkdtempSync, realpathSync, symlinkSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const declaration = `export default defineEntity({
  fields: {
    name: { type: 'text', required: true },
    user: accountLink(),
  },
  displayField: 'name',
})`
function consumer(entity = declaration, config = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbase-entity-')))
  roots.push(root)
  mkdirSync(join(root, 'schema'))
  mkdirSync(join(root, 'node_modules/@workbasehq'), { recursive: true })
  symlinkSync(resolve('packages/core'), join(root, 'node_modules/@workbasehq/core'), 'dir')
  const schema = '@workbasehq/core/schema'
  writeFileSync(join(root, 'schema/worker.ts'), `import { defineEntity, accountLink } from ${JSON.stringify(schema)}\n${entity}\n`)
  let configSource = `import { defineConfig } from ${JSON.stringify(schema)}
import worker from './schema/worker'
export default defineConfig({
  id: 'sample', revision: 1,
  roles: ['admin', 'staff'], organizationOwnerRole: 'admin',
  languages: ['cs', 'en'],
  entities: { worker },
})\n`
  if (config) {
    const option = config.split(':')[0]
    configSource = configSource.replace(new RegExp(`${option}: [^\\n]+`), config)
  }
  writeFileSync(join(root, 'config.ts'), configSource)
  writeFileSync(join(root, 'run.ts'), `import { loadConfig } from ${JSON.stringify('@workbasehq/core/schema/load')}
try { console.log(JSON.stringify(await loadConfig(${JSON.stringify(join(root, 'config.ts'))}))) }
catch (error) { console.error(error.message); process.exit(1) }`)
  const run = () => spawnSync('bun', [join(root, 'run.ts')], { encoding: 'utf8' })
  return { root, run }
}

it('loads explicit worker imports into the canonical normalized schema snapshot', () => {
  const { root, run } = consumer()
  const result = run()
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  const { config, sources } = JSON.parse(result.stdout)
  expect(config).toMatchSnapshot()
  expect(sources['entities.worker.fields.name']).toEqual({ file: join(root, 'schema/worker.ts'), line: 4, column: 5 })
  expect(config.roles).toEqual(['admin', 'staff'])
  expect(config.languages[0]).toBe('cs')
})

describe('source diagnostics', () => {
  it.each([
    ['spread', declaration.replace("name: { type: 'text', required: true }", "...{ name: { type: 'text' } }"), 'schema/worker.ts:4:', 'Spread'],
    ['variable reference', `const options = { type: 'text' }\n${declaration.replace("{ type: 'text', required: true }", 'options')}`, 'schema/worker.ts:5:', 'literal'],
    ['function call', declaration.replace("{ type: 'text', required: true }", "String('text')"), 'schema/worker.ts:4:', 'call'],
    ['unknown relation target', declaration.replace("displayField: 'name',", "relations: { other: { field: 'user', entity: 'missing' } },"), 'schema/worker.ts:7:', 'Unknown relation target'],
    ['unknown field type', declaration.replace("type: 'text'", "type: 'number'"), 'schema/worker.ts:4:', 'type'],
  ])('rejects %s with file:line', (_name, entity, location, message) => {
    const { root, run } = consumer(entity)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(join(root, location))
    expect(result.stderr).toContain(message)
  })
  it.each([
    ['SDK-owned users', 'entities: { users: worker },', 'config.ts:7:', 'SDK-owned'],
    ['unknown owner role', "organizationOwnerRole: 'missing',", 'config.ts:5:', 'organizationOwnerRole'],
    ['empty languages', 'languages: [],', 'config.ts:6:', 'languages'],
  ])('rejects %s with file:line', (_name, override, location, message) => {
    const { root, run } = consumer(declaration, override)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(join(root, location))
    expect(result.stderr).toContain(message)
  })
})

it.each([
  ['nested spread', declaration.replace("{ type: 'text', required: true }", "{ type: 'text', ...{ required: true } }"), 'Spread'],
  ['array spread', declaration.replace("type: 'text', required: true", "type: 'enum', values: [...['open']]"), 'literal'],
  ['shorthand property', `const name = { type: 'text' }\n${declaration.replace("name: { type: 'text', required: true }", 'name')}`, 'literal'],
  ['computed property', declaration.replace("name: { type: 'text', required: true }", "['na' + 'me']: { type: 'text' }"), 'Computed'],
  ['accessor', declaration.replace("name: { type: 'text', required: true }", "get name() { return { type: 'text' } }"), 'literal'],
  ['duplicate property', declaration.replace("type: 'text', required: true", "type: 'text', type: 'bool'"), 'Duplicate'],
  ['account helper argument', declaration.replace('accountLink()', "accountLink('value')"), 'call'],
  ['account helper at another field', declaration.replace('user: accountLink()', 'other: accountLink()'), 'call'],
  ['unknown reference', declaration.replace('user: accountLink()', "other: { type: 'ref', entity: 'missing' }"), 'Unknown reference'],
  ['boolean alias', declaration.replace("type: 'text'", "type: 'boolean'"), 'type'],
  ['inline labels', declaration.replace("displayField: 'name',", "labels: { en: 'Sample' },"), 'Unrecognized key'],
  ['nonliteral declaration', `const fields = { name: { type: 'text' } }\nexport default defineEntity(fields)`, 'literal object'],
])('enforces the complete literal boundary: %s', (_name, entity, message) => {
  const { root, run } = consumer(entity)
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(join(root, 'schema/worker.ts:'))
  expect(result.stderr).toContain(message)
})

it('rejects a forbidden literal before executing the schema module', () => {
  const { run } = consumer(`throw new Error('MODULE_EXECUTED')\n${declaration.replace("{ type: 'text', required: true }", 'arbitraryCall()')}`)
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Function call is outside the literal boundary')
  expect(result.stderr).not.toContain('MODULE_EXECUTED')
})

it('accepts named entity exports and imported SDK helper aliases', () => {
  const { root, run } = consumer(declaration.replace('export default', 'export const worker ='))
  const file = join(root, 'schema/worker.ts')
  writeFileSync(file, `import { defineEntity as entity, accountLink as link } from ${JSON.stringify(resolve('packages/core/src/schema.ts'))}\n${declaration.replace('export default', 'export const worker =').replace('defineEntity(', 'entity(').replace('accountLink()', 'link()')}`)
  const config = join(root, 'config.ts')
  writeFileSync(config, `import { defineConfig as config } from ${JSON.stringify(resolve('packages/core/src/schema.ts'))}
import { worker as sample } from './schema/worker.ts'
export default config({ id: 'sample', revision: 1, roles: ['admin'], organizationOwnerRole: 'admin', languages: ['en'], entities: { worker: sample } })`)
  const result = run()
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).config.entities.worker.relations.user_account).toEqual({ entity: 'users', field: 'user' })
})

it.each([
  ["entities: { worker: { fields: {} } },", 'explicit schema import'],
  ["entities: { probe: worker },", 'match schema/<entity>.ts'],
])('requires explicit matching schema imports: %s', (override, message) => {
  const { root, run } = consumer(declaration, override)
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(join(root, 'config.ts:7:'))
  expect(result.stderr).toContain(message)
})

it('loads legacy inline config through its unchanged entry', () => {
  const { root, run } = consumer()
  writeFileSync(join(root, 'config.ts'), `import { defineInstance } from ${JSON.stringify(resolve('packages/core/src/config.ts'))}
export default defineInstance({ id: 'sample', revision: 1, roles: ['owner'], entities: { worker: { fields: { name: { type: 'text', required: true } } } }, permissions: {} })`)
  const result = run()
  expect(result.status).toBe(0)
  const { config } = JSON.parse(result.stdout)
  expect(config.roles).toEqual(['owner', 'member'])
  expect(config.entities.worker.fields.name).toEqual({ type: 'text', required: true })
  expect(config).not.toHaveProperty('languages')
})
