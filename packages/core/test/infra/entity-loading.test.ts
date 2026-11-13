import { mkdtempSync, realpathSync, symlinkSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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
  writeFileSync(join(root, 'run.ts'), `import config from './config.ts'; console.log(JSON.stringify({ config }))`)
  const result = run()
  expect(result.status).toBe(0)
  const { config } = JSON.parse(result.stdout)
  expect(config.roles).toEqual(['owner', 'member'])
  expect(config.entities.worker.fields.name).toEqual({ type: 'text', required: true })
  expect(config).not.toHaveProperty('languages')
})

// Review regressions: each sentinel must remain unexecuted when preflight fails.
const executed = `(() => { console.log('ENTITY_CALL_EXECUTED'); return { type: 'text', required: true } })()`
it('rejects ambiguous extensionless imports before Bun executes a shadow module', () => {
  const { root, run } = consumer()
  writeFileSync(join(root, 'schema/worker.tsx'), readFileSync(join(root, 'schema/worker.ts'), 'utf8').replace("{ type: 'text', required: true }", executed))
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('config.ts:2:')
  expect(result.stdout).not.toContain('EXECUTED')
})

it.each([
  ['wrapped default', (s: string) => s.replace('export default defineConfig(', 'const result = defineConfig(') + '\nexport default result'],
  ['local helper alias', (s: string) => s.replace('export default defineConfig(', 'const make = defineConfig; export default make(')],
  ['namespace helper', (s: string) => s.replace('{ defineConfig }', '* as sdk').replace('defineConfig({', 'sdk.defineConfig({')],
  ['re-export', () => "export { default } from './actual-config.ts'"],
  ['default helper import', (s: string) => s.replace("{ defineConfig } from \"@workbasehq/core/schema\"", "defineConfig from './helper.ts'")],
  ['spread copy', (s: string) => s.replace('export default defineConfig(', 'const result = defineConfig(') + '\nexport default { ...result }'],
  ['extra export', (s: string) => s + "\nexport const extra = console.log('CONFIG_EXECUTED')"],
  ['side-effect import', (s: string) => "import './side-effect.ts'\n" + s],
  ['top-level expression', (s: string) => "console.log('CONFIG_EXECUTED')\n" + s],
  ['unused imported helper', (s: string) => "import { helper } from './side-effect.ts'\n" + s],
  ['config property call', (s: string) => s.replace("id: 'sample'", "id: (() => { console.log('CONFIG_EXECUTED'); return 'sample' })()")],
])('rejects noncanonical config before executing imports: %s', (_name, transform) => {
  const { root, run } = consumer(declaration.replace("{ type: 'text', required: true }", executed))
  const configFile = join(root, 'config.ts')
  const original = readFileSync(configFile, 'utf8')
  writeFileSync(join(root, 'actual-config.ts'), original)
  writeFileSync(join(root, 'helper.ts'), "export { defineConfig as default } from '@workbasehq/core/schema'")
  writeFileSync(join(root, 'side-effect.ts'), "console.log('IMPORT_EXECUTED'); export const helper = 1")
  writeFileSync(configFile, transform(original))
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('config.ts:')
  expect(result.stdout).not.toContain('EXECUTED')
})

it.each([
  ['numeric constraint', declaration.replace("name: { type: 'text', required: true }", "name: {\n      type: 'text',\n      min: 0\n    }"), 6, 7, 'min requires a numeric field'],
  ['relation field', declaration.replace("displayField: 'name',", "relations: {\n    other: {\n      field: 'absent',\n      entity: 'users'\n    }\n  },"), 9, 7, 'Invalid relation'],
  ['array descendant', declaration.replace("displayField: 'name',", "checks: [\n    {\n      left: 'name',\n      op: '==',\n      right: 'name'\n    }\n  ],"), 10, 7, 'op'],
])('maps %s to the exact entity property', (_name, entity, line, column, message) => {
  const { root, run } = consumer(entity)
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(join(root, `schema/worker.ts:${line}:${column}:`))
  expect(result.stderr).toContain(message)
})

it('indexes object properties inside arrays in the returned source map', () => {
  const { root, run } = consumer(declaration.replace("displayField: 'name',", "checks: [\n    {\n      left: 'name',\n      op: '<=',\n      right: 'name'\n    }\n  ],"))
  const result = run()
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).sources['entities.worker.checks.0.op']).toEqual({ file: join(root, 'schema/worker.ts'), line: 10, column: 7 })
})

it('rejects legacy calls in the canonical loader before evaluation', () => {
  const { root, run } = consumer()
  writeFileSync(join(root, 'config.ts'), `import { defineInstance } from '@workbasehq/core/config'
export default defineInstance((() => { console.log('LEGACY_EXECUTED'); return {} })())`)
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('config.ts:2:')
  expect(result.stdout).not.toContain('EXECUTED')
})

it('accepts parenthesized as/satisfies wrappers around direct declarations', () => {
  const { root, run } = consumer(declaration.replace('defineEntity({', '(defineEntity({').replace('})', '}) as const)'))
  const path = join(root, 'config.ts')
  writeFileSync(path, readFileSync(path, 'utf8').replace('export default defineConfig({', 'export default (defineConfig({').replace('})', '}) satisfies unknown)'))
  expect(run().status).toBe(0)
})

it.each(['expression', 'side-effect import', 'extra export'])('rejects executable entity module statements: %s', kind => {
  const { root, run } = consumer()
  const file = join(root, 'schema/worker.ts')
  const extra = kind === 'side-effect import' ? "import '../side-effect.ts'" : kind === 'extra export' ? "export const extra = console.log('ENTITY_EXECUTED')" : "console.log('ENTITY_EXECUTED')"
  writeFileSync(join(root, 'side-effect.ts'), "console.log('IMPORT_EXECUTED')")
  writeFileSync(file, readFileSync(file, 'utf8') + '\n' + extra)
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('schema/worker.ts:')
  expect(result.stdout).not.toContain('EXECUTED')
})

it('rejects a resolved entity outside the canonical schema path', () => {
  const { root, run } = consumer()
  const file = join(root, 'schema/worker.ts')
  writeFileSync(join(root, 'actual.ts'), readFileSync(file, 'utf8').replace("{ type: 'text', required: true }", executed))
  rmSync(file)
  symlinkSync(join(root, 'actual.ts'), file)
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Resolved entity import must match')
  expect(result.stdout).not.toContain('EXECUTED')
})

it('maps errors in the second entity to that entity rather than the config root', () => {
  const { root, run } = consumer()
  writeFileSync(join(root, 'schema/probe.ts'), readFileSync(join(root, 'schema/worker.ts'), 'utf8').replace("name: { type: 'text', required: true }", "name: {\n      type: 'text',\n      min: 0\n    }"))
  const file = join(root, 'config.ts')
  writeFileSync(file, readFileSync(file, 'utf8').replace("import worker", "import probe from './schema/probe.ts'\nimport worker").replace('entities: { worker }', 'entities: { worker, probe }'))
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(join(root, 'schema/probe.ts:6:7:'))
})

it('maps kernel expression errors to the computed property', () => {
  const { root, run } = consumer(declaration.replace("name: { type: 'text', required: true }", "name: {\n      type: 'text',\n      computed: 'invalid'\n    }"))
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(join(root, 'schema/worker.ts:6:7:'))
})

it('maps signed-field semantics to the entity metadata property', () => {
  const { root, run } = consumer(declaration.replace("name: { type: 'text', required: true }", "name: { type: 'text', required: true,\n      ui: { signedBy: {\n        field: 'missing',\n        negativeValue: 'negative'\n      } }\n    }"))
  const file = join(root, 'config.ts')
  writeFileSync(file, readFileSync(file, 'utf8').replace("  entities:", "  ui: { entities: { worker: {} } },\n  entities:"))
  const result = run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(join(root, 'schema/worker.ts:6:9:'))
})
