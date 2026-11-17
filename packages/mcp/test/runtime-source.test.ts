import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { applyRuntimeChanges, parseRuntimeSource, printRuntimeSource, rewriteRuntimeSource } from '../src/composition/runtime-source.ts'
import { hydrateRuntimePlugins } from '../src/composition/registry.ts'
import { changeSchema, compositionChangeSchema, setPluginSchema, type CompositionChange } from '../src/schemas.ts'
import type { WorkbasePlugin } from '@workbasehq/core/plugins'

const config = { roles: ['admin', 'staff'], organizationOwnerRole: 'admin' }
const thin = `import { identity } from '@workbasehq/plugins/identity'
import { members } from '@workbasehq/plugins/members'
import { permissions } from '@workbasehq/plugins/permissions'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import config from './config'

// Authored composition comment.
export default { ...config, plugins: [identity, members, permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' }), machineCredentials()] }
`
const changes: CompositionChange[] = [
  { kind: 'set_plugin', plugin: 'organizations', options: { allowCreate: false } },
  { kind: 'set_plugin', plugin: 'local-auth', options: { methods: ['magic-link'] } },
  { kind: 'set_plugin', plugin: 'mail-outbox' },
  { kind: 'set_plugin', plugin: 'audit' },
  { kind: 'set_plugin', plugin: 'console' },
  { kind: 'set_interactive', interactive: true },
]
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const template = () => readFile(resolve('packages/mcp/templates/standalone/runtime.ts'), 'utf8')
const descriptors = (plugins: WorkbasePlugin[]) => plugins.map(({ name, version, provides, requires, optionalRequires, configuration }) =>
  JSON.parse(JSON.stringify({ name, version, provides, requires, optionalRequires, configuration })))
it('parses the template and compatibility singletons and prints the six-change golden byte-for-byte', async () => {
  const target = applyRuntimeChanges(parseRuntimeSource(thin), changes, config)
  expect(printRuntimeSource(target, config)).toBe(await template())
  expect(parseRuntimeSource(await template())).toEqual(target)
  expect(applyRuntimeChanges(target, changes, config)).toEqual(target)
  expect(target.plugins.find(plugin => plugin.plugin === 'identity')).toEqual({ plugin: 'identity' })
})
it('accepts arbitrary import and plugin order and retains semantic model equality', async () => {
  const source = await template()
  const model = parseRuntimeSource(source)
  const lines = source.split('\n')
  const imports = lines.slice(0, 10)
  const calls = ['consoleUI()', 'audit()', 'mailOutbox()', 'machineCredentials()', "createLocalAuth({ methods: ['magic-link'] })", 'createOrganizations({ allowCreate: false })', 'createMembers()', "permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' })", 'createIdentity()']
  for (let offset = 0; offset < imports.length; offset++) {
    const reordered = [...imports.slice(offset), ...imports.slice(0, offset)].join('\n') + `\nexport default { ...config, plugins: [${calls.join(', ')}], interactive: true }\n`
    expect(parseRuntimeSource(reordered)).toEqual(model)
  }
})
it.each([
  ['extra spread', (source: string) => source.replace('plugins: [identity', '...config, plugins: [identity')],
  ['plugin spread', (source: string) => source.replace('[identity, members,', '[...identity, members,')],
  ['unknown import', (source: string) => source.replace('@workbasehq/plugins/identity', '@workbasehq/plugins/custom')],
  ['computed argument', (source: string) => source.replace("['admin', 'staff']", 'config.roles')],
  ['extra statement', (source: string) => source + 'doSomething()\n'],
  ['side effect import', (source: string) => "import 'custom'\n" + source],
  ['namespace import', (source: string) => source.replace('{ identity }', '* as identity')],
  ['unknown export', (source: string) => source.replace('{ identity }', '{ custom as identity }')],
  ['duplicate plugin', (source: string) => source.replace('[identity, members,', '[identity, identity, members,')],
  ['duplicate property', (source: string) => source.replace('plugins: [', 'interactive: true, interactive: false, plugins: [')],
  ['unknown property', (source: string) => source.replace('plugins: [', 'commands: [], plugins: [')],
  ['computed key', (source: string) => source.replace('plugins: [', "['plugins']: [")],
  ['unimported factory', (source: string) => source.replace('machineCredentials()]', 'other()]')],
  ['singleton call', (source: string) => source.replace('[identity,', '[identity(),')],
  ['bare factory', (source: string) => source.replace('machineCredentials()]', 'machineCredentials]')],
  ['option spread', (source: string) => source.replace("{ roles: ['admin', 'staff']", "{ ...config, roles: ['admin', 'staff']")],
  ['syntax error', (source: string) => source + 'export default {'],
])('rejects %s with a file and line', (_name, mutate) => {
  expect(() => parseRuntimeSource(mutate(thin), 'instance/runtime.ts')).toThrow(expect.objectContaining({
    code: 'runtime_not_canonical', message: expect.stringMatching(/instance\/runtime.ts:\d+:\d+:/),
    details: expect.objectContaining({ file: 'instance/runtime.ts', line: expect.any(Number) }),
  }))
})
it('preserves comments, import order, aliases and all bytes outside the export literal', () => {
  const source = thin.replace('{ identity }', '{ identity as loginIdentity }').replace('[identity,', '[loginIdentity,')
    .replace("import config from './config'", "import appConfig from './config'").replace('...config,', '...appConfig,')
    .replace('\n// Authored', '\n/* retained header */\n// Authored') + '// retained footer\n'
  const model = applyRuntimeChanges(parseRuntimeSource(source), [{ kind: 'set_interactive', interactive: true }], config)
  const rewritten = rewriteRuntimeSource(source, model, config)
  const prefix = source.slice(0, source.indexOf('export default {')).replace('{ identity as loginIdentity }', '{ createIdentity as loginIdentity }').replace('{ members }', '{ createMembers as members }')
  expect(rewritten.startsWith(prefix + 'export default {')).toBe(true)
  expect(rewritten.endsWith('// retained footer\n')).toBe(true)
  expect(rewritten).toContain('loginIdentity()')
  expect(parseRuntimeSource(rewritten)).toEqual(model)
  expect(rewriteRuntimeSource(rewritten, model, config)).toBe(rewritten)
})
it.each([
  ['identity /* preserve-me */ as id', 'id', 'createIdentity /* preserve-me */ as id'],
  ['identity /* before-as */ as /* after-as */ id', 'id', 'createIdentity /* before-as */ as /* after-as */ id'],
  ['identity // before-as\n as id', 'id', 'createIdentity // before-as\n as id'],
  ['identity /* unaliased */', 'identity', 'createIdentity as identity /* unaliased */'],
  ['identity // unaliased\n', 'identity', 'createIdentity as identity // unaliased\n'],
  ['identity /* trailing */ as id /* after-binding */', 'id', 'createIdentity /* trailing */ as id /* after-binding */'],
  ['identity /* escaped alias */ as \\u0069d', 'id', 'createIdentity /* escaped alias */ as \\u0069d'],
])('preserves authored import trivia when converting %s', (specifier, local, expected) => {
  const source = `// header\nimport { /* leading */ ${specifier} } from '@workbasehq/plugins/identity'\nimport config from './config'\nexport default { ...config, plugins: [${local}] }\n// footer\n`
  const target = applyRuntimeChanges(parseRuntimeSource(source), [{ kind: 'set_interactive', interactive: true }], config)
  const rewritten = rewriteRuntimeSource(source, target, config)
  expect(rewritten.slice(0, rewritten.indexOf('export default'))).toBe(
    source.slice(0, source.indexOf('export default')).replace(specifier, expected),
  )
  expect(rewritten.endsWith('\n// footer\n')).toBe(true)
  expect(parseRuntimeSource(rewritten)).toEqual(target)
  expect(rewriteRuntimeSource(rewritten, target, config)).toBe(rewritten)
})
it.each([
  'eval', 'arguments', 'await', 'yield', 'let', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'static',
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', '1invalid', 'invalid-name', '\\u0065val', '\\u0061rguments',
])('rejects invalid module binding %s in plugin and config imports', local => {
  for (const source of [
    `import { createIdentity as ${local} } from '@workbasehq/plugins/identity'\nimport config from './config'\nexport default { ...config, plugins: [] }\n`,
    `import ${local} from './config'\nexport default { ...${local}, plugins: [] }\n`,
  ]) {
    expect(() => parseRuntimeSource(source, 'instance/runtime.ts')).toThrow(expect.objectContaining({
      code: 'runtime_not_canonical', message: expect.stringMatching(/instance\/runtime.ts:\d+:\d+:/),
      details: expect.objectContaining({ file: 'instance/runtime.ts', line: expect.any(Number), column: expect.any(Number) }),
    }))
  }
})
it('reports invalid bindings at the local identifier without exposing source text', () => {
  const source = `import { createIdentity /* private-canary */ as eval } from '@workbasehq/plugins/identity'\nimport config from './config'\nexport default { ...config, plugins: [eval()] }\n`
  expect(() => parseRuntimeSource(source, 'instance/runtime.ts')).toThrow(expect.objectContaining({
    code: 'runtime_not_canonical',
    details: { file: 'instance/runtime.ts', line: 1, column: source.indexOf('eval') + 1 },
    message: expect.not.stringContaining('private-canary'),
  }))
})
it.each(['id', '$identity', '_identity', 'café', '𐐀identity', 'async', 'of', 'type', 'using', '\\u0069d'])(
  'accepts valid module binding %s', local => {
    const source = `import { createIdentity as ${local} } from '@workbasehq/plugins/identity'\nimport config from './config'\nexport default { ...config, plugins: [${local}()] }\n`
    expect(parseRuntimeSource(source)).toEqual({ plugins: [{ plugin: 'identity' }] })
  },
)
it('adds missing imports without discarding authored imports or comments', () => {
  const target = applyRuntimeChanges(parseRuntimeSource(thin), changes, config)
  const rewritten = rewriteRuntimeSource(thin, target, config)
  expect(rewritten).toContain('// Authored composition comment.\nexport default')
  expect(rewritten).toContain("import config from './config'")
  expect(parseRuntimeSource(rewritten)).toEqual(target)
})
it('round trips literal options and always derives permission options from the config', () => {
  const model = applyRuntimeChanges(parseRuntimeSource(thin), [{ kind: 'set_plugin', plugin: 'identity', options: {
    trustedIssuers: { 'https://issuer.example.test': ["quote'back\\slash", 'control\nline\ttab'] },
  } }], { roles: ['owner', 'viewer'], organizationOwnerRole: 'owner' })
  const printed = printRuntimeSource(model, { roles: ['owner', 'viewer'], organizationOwnerRole: 'owner' })
  expect(parseRuntimeSource(printed)).toEqual(model)
  expect(printed).toContain("roles: ['owner', 'viewer'], ownerRole: 'owner'")
  expect(parseRuntimeSource(printRuntimeSource(model, config)).plugins.find(plugin => plugin.plugin === 'permissions')?.options).toEqual({ roles: config.roles, ownerRole: 'admin' })
})
it('imports printed and source-preserved runtime bytes with the same descriptors as the hydrated model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-source-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'config.ts'), `export default ${JSON.stringify(config)}\n`)
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  const model = applyRuntimeChanges(parseRuntimeSource(thin), changes, config)
  const expected = descriptors(hydrateRuntimePlugins(model, config))
  for (const [name, source] of [['canonical', printRuntimeSource(model, config)], ['authored', rewriteRuntimeSource(thin, model, config)]]) {
    const file = join(root, `${name}.ts`)
    await writeFile(file, source)
    const imported = await tsImport(pathToFileURL(file).href, import.meta.url)
    expect(descriptors(imported.default.plugins)).toEqual(expected)
  }
})
it('exports strict composition schemas without changing the legacy proposal union', () => {
  for (const change of changes) {
    expect(compositionChangeSchema.safeParse(change).success).toBe(true)
    expect(changeSchema.safeParse(change).success).toBe(false)
  }
  for (const plugin of ['members', 'mail-outbox', 'audit', 'machine-credentials', 'console']) {
    expect(setPluginSchema.safeParse({ kind: 'set_plugin', plugin, options: {} }).success).toBe(false)
  }
  for (const change of [
    { plugin: 'permissions' }, { plugin: 'custom' }, { plugin: 'organizations', options: { other: true } },
    { plugin: 'local-auth', options: { methods: ['password'] } }, { plugin: 'local-auth', options: { methods: ['magic-link', 'magic-link'] } },
    { plugin: 'identity', options: { trustedIssuers: { invalid: ['example.test'] } } },
  ]) expect(setPluginSchema.safeParse({ kind: 'set_plugin', ...change }).success).toBe(false)
})
