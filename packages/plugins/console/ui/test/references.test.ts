import { afterEach, expect, test } from 'vitest'
import { rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { referenceInventory, validateRemoval } from '@workbasehq/core/references'
import { checkSources, normalise } from '../src/check'
import { consoleReferences, validateInstanceReferences } from '../src/references'
import { pluginReferences } from '../src/plugin-references'
import { entityListPage, entityDetailPage, link, slot, p } from '../src/index'
import { fixture, sdk } from './fixture'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
test('shared literal layouts retain exact definition spans and both page consumers', () => {
  const { root, put } = fixture(); roots.push(root)
  put('ui/-shared.ts', `export const fields = ['name'] as const`)
  put('ui/index.ts', `import { entityListPage } from '${sdk}'\nimport { fields } from './-shared'\nexport default entityListPage('worker', { title: 'worker.list', layout: fields })`)
  put('ui/$id.ts', `import { entityDetailPage } from '${sdk}'\nimport { fields } from './-shared'\nexport default entityDetailPage('worker', { title: 'worker.detail', recordParam: 'id', layout: fields })`)
  put('ui/nav.ts', `import { defineNav, link } from '${sdk}'\nexport default defineNav([{ title: 'worker.list', target: link('worker', 'list') }])`)
  const sources = checkSources(root)
  const values = { 'ui/index.ts': entityListPage('worker', { title: 'worker.list', layout: ['name'] }),
    'ui/$id.ts': entityDetailPage('worker', { title: 'worker.detail', recordParam: 'id', layout: ['name'] }),
    'ui/nav.ts': [{ title: 'worker.list', target: link('worker', 'list') }] }
  const manifest = normalise(sources, values, { worker: { fields: { name: { type: 'text' } } } }, 'test')
  const result = consoleReferences(sources, manifest, values)
  expect(result.diagnostics).toEqual([])
  const fields = result.references.filter(r => ['layout', 'list-column'].includes(r.kind))
  expect(fields).toHaveLength(2)
  expect(fields.every(r => r.source.file.endsWith('/ui/-shared.ts'))).toBe(true)
  expect(fields.every(r => sources.modules.get(r.source.file)!.slice(r.source.start, r.source.end) === "'name'")).toBe(true)
  expect(new Set(fields.flatMap(r => r.useSites.map(u => u.owner))).size).toBe(2)
  expect(result.references.some(r => r.kind === 'nav')).toBe(true)
})
test('typed required slots and custom uses are inventory references; key/boolean strings are not fields', () => {
  const { root, put } = fixture(); roots.push(root)
  put('ui/index.ts', `import { entityListPage, slot } from '${sdk}'\nexport default entityListPage('worker', { title: 'worker.list', uses: ['worker.name'], layout: [slot('card', { field: 'name', label: 'worker.name', active: true })] })`)
  put('ui/-slots.ts', `import { defineSlots, p } from '${sdk}'\nexport default defineSlots({ card: { contexts: ['row'], props: { field: p.field('text'), label: p.key(), active: p.boolean() }, component: () => null } })`)
  const sources = checkSources(root), values = { 'ui/index.ts': entityListPage('worker', { title: 'worker.list', uses: ['worker.name'], layout: [slot('card', { field: 'name', label: 'worker.name', active: true })] }),
    'ui/-slots.ts': { card: { contexts: ['row'], props: { field: p.field('text'), label: p.key(), active: p.boolean() }, component: () => null } } }
  const manifest = normalise(sources, values, { worker: { fields: { name: { type: 'text' } } } }, 'test')
  const result = consoleReferences(sources, manifest, values)
  expect(result.diagnostics).toEqual([])
  expect(result.references.filter(r => r.target.field)).toHaveLength(3)
  expect(result.references.filter(r => r.kind === 'slot')).toHaveLength(2)
  expect(result.references.find(r => r.kind === 'uses')!.source.end).toBeGreaterThan(0)
})
test('declared plugin fields block removal but contract names remain a separate inventory', () => {
  const { root, put } = fixture(); roots.push(root)
  put('runtime.ts', `import custom from './plugin'\nexport default { plugins: [custom] }`)
  put('plugin.ts', `export default { name: 'custom', version: '1', requires: { worker: '^1' }, schemaReferences: [{ entity: 'worker', field: 'name' }] }`)
  const result = pluginReferences(root)
  expect(result.uncovered).toEqual([])
  expect(result.contracts).toMatchObject([{ plugin: 'custom', contract: 'worker', range: '^1' }])
  expect(result.references).toMatchObject([{ kind: 'plugin', target: { entity: 'worker', field: 'name' } }])
  expect(result.references[0].source.file.endsWith('/plugin.ts')).toBe(true)
  const removed = validateRemoval({ ...result, diagnostics: [] }, { kind: 'remove_field', entity: 'worker', field: 'name' })
  expect(removed.diagnostics).toHaveLength(1)
})
test('computed UI provenance and undeclared custom plugin dependencies are explicit diagnostics', () => {
  const { root, put } = fixture(); roots.push(root)
  put('ui/index.ts', `import { entityListPage } from '${sdk}'\nconst fields = ['name'].map(x => x)\nexport default entityListPage('worker', { title: 'worker.list', layout: fields })`)
  const sources = checkSources(root), values = { 'ui/index.ts': entityListPage('worker', { title: 'worker.list', layout: ['name'] }) }
  const manifest = normalise(sources, values, { worker: { fields: { name: { type: 'text' } } } }, 'test')
  expect(consoleReferences(sources, manifest, values).diagnostics.map(d => d.code)).toContain('reference-provenance')
  put('runtime.ts', `import custom from './plugin'\nexport default { plugins: [custom] }`)
  put('plugin.ts', `export default { name: 'custom', version: '1' }`)
  expect(pluginReferences(root).uncovered.map(d => d.code)).toContain('opaque-plugin-reference')
})

test.each([
  ['exported variable', `const runtime = { ...config, plugins: [custom] }; export default runtime`],
  ['object spread', `const composition = { plugins: [custom] }; export default { ...config, ...composition }`],
])('runtime plugin coverage blocks removal through %s', async (_name, runtime) => {
  const { root, put } = fixture(); roots.push(root)
  rmSync(join(root, 'ui'), { recursive: true })
  put('schema/worker.ts', `import { defineEntity } from '@workbasehq/core/schema'\nexport default defineEntity({ fields: { name: { type: 'text' }, note: { type: 'text' } } })`)
  put('plugin.ts', `export default { name: 'custom', version: '1', schemaReferences: [{ entity: 'worker', field: 'note' }] }`)
  put('runtime.ts', `import config from './config'\nimport custom from './plugin'\n${runtime}`)
  const result = await validateInstanceReferences(root, { kind: 'remove_field', entity: 'worker', field: 'note' })
  expect(result.ok).toBe(false)
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'opaque-plugin-reference', kind: 'plugin', message: expect.stringContaining('coverage is unknown') }))
})

test('independent linked source failures retain both errors and the known plugin blocker', async () => {
  const { root, put } = fixture(); roots.push(root)
  rmSync(join(root, 'ui'), { recursive: true })
  put('schema/worker.ts', `import { defineEntity } from '@workbasehq/core/schema'\nexport default defineEntity({ fields: { name: { type: 'text' }, note: { type: 'text' } } })`)
  put('plugin.ts', `export default { name: 'custom', version: '1', schemaReferences: [{ entity: 'worker', field: 'note' }] }`)
  put('runtime.ts', `import custom from './plugin'\nexport default { plugins: [custom] }`)
  mkdirSync(join(root, 'src'))
  for (const name of ['a-linked.ts', 'z-linked.ts']) symlinkSync(join(root, 'plugin.ts'), join(root, 'src', name))
  put('src/ordinary.ts', 'export const value = 1')
  const result = await validateInstanceReferences(root, { kind: 'remove_field', entity: 'worker', field: 'note' })
  expect(result.ok).toBe(false)
  expect(result.diagnostics.filter(d => d.code === 'reference-source').map(d => d.source.file)).toEqual([
    join(root, 'src/a-linked.ts'), join(root, 'src/z-linked.ts'),
  ])
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'removal-reference', kind: 'plugin', owner: 'plugin:custom' }))
  expect(result.inventory.references).toContainEqual(expect.objectContaining({ kind: 'plugin', target: { entity: 'worker', field: 'note' } }))
  expect(result.inventory.uncovered).toContainEqual(expect.objectContaining({ code: 'opaque-instance-code', source: expect.objectContaining({ file: join(root, 'src/ordinary.ts') }) }))
})

// Review2 reproductions: these all execute as worker.note references.
test.each([
  ['computed field key', `export default { name: 'custom', version: '1', schemaReferences: [{ entity: 'worker', ['field']: 'note' }] }`],
  ['spread supplying field', `const target = { field: 'note' }; export default { name: 'custom', version: '1', schemaReferences: [{ entity: 'worker', ...target }] }`],
  ['computed metadata override', `let key: string = 'schemaReferences'; export default { name: 'custom', version: '1', schemaReferences: [], [key]: [{ entity: 'worker', field: 'note' }] }`],
])('non-canonical plugin metadata blocks instance field removal: %s', async (_name, plugin) => {
  const { root, put } = fixture(); roots.push(root)
  rmSync(join(root, 'ui'), { recursive: true })
  put('schema/worker.ts', `import { defineEntity } from '@workbasehq/core/schema'\nexport default defineEntity({ fields: { name: { type: 'text' }, note: { type: 'text' } } })`)
  put('plugin.ts', plugin)
  put('runtime.ts', `import config from './config'\nimport custom from './plugin'\nexport default { ...config, plugins: [custom] }`)
  const result = await validateInstanceReferences(root, { kind: 'remove_field', entity: 'worker', field: 'note' })
  expect(result.ok).toBe(false)
  expect(result.inventory.uncovered).toContainEqual(expect.objectContaining({ code: 'opaque-plugin-reference', kind: 'plugin' }))
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'opaque-plugin-reference', kind: 'plugin' }))
})

const canonicalReference = `[{ entity: 'worker', field: 'note' }]`
test.each([
  ['computed entity', `schemaReferences: [{ ['entity']: 'worker', field: 'note' }]`],
  ['computed field', `schemaReferences: [{ entity: 'worker', ['field']: 'note' }]`],
  ['spread member', `schemaReferences: [{ entity: 'worker', ...{ field: 'note' } }]`],
  ['unknown member', `schemaReferences: [{ entity: 'worker', typo: 'note' }]`],
  ['unknown member beside field', `schemaReferences: [{ entity: 'worker', field: 'note', extra: 'ignored' }]`],
  ['duplicate member', `schemaReferences: [{ entity: 'worker', field: 'name', field: 'note' }]`],
  ['shorthand member', `schemaReferences: [{ entity: 'worker', field }]`],
  ['getter member', `schemaReferences: [{ entity: 'worker', get field() { return 'note' } }]`],
  ['method member', `schemaReferences: [{ entity: 'worker', field() { return 'note' } }]`],
  ['numeric member', `schemaReferences: [{ entity: 'worker', 0: 'note' }]`],
  ['variable value', `schemaReferences: [{ entity: 'worker', field: field }]`],
  ['call value', `schemaReferences: [{ entity: 'worker', field: String('note') }]`],
  ['conditional value', `schemaReferences: [{ entity: 'worker', field: true ? 'note' : 'name' }]`],
  ['template value', 'schemaReferences: [{ entity: `worker`, field: `note` }]'],
  ['missing entity', `schemaReferences: [{ field: 'note' }]`],
  ['non-string value', `schemaReferences: [{ entity: 'worker', field: undefined }]`],
  ['variable item', `schemaReferences: [target]`],
  ['spread array', `schemaReferences: [...refs]`],
  ['array hole', `schemaReferences: [,]`],
  ['variable array', `schemaReferences: refs`],
  ['call array', `schemaReferences: refs.map(x => x)`],
  ['conditional array', `schemaReferences: true ? refs : []`],
  ['asserted array', `schemaReferences: ${canonicalReference} as const`],
  ['parenthesized array', `schemaReferences: (${canonicalReference})`],
  ['computed metadata', `['schemaReferences']: ${canonicalReference}`],
  ['unknown computed override', `schemaReferences: [], [key]: ${canonicalReference}`],
  ['computed before metadata', `[key]: refs, schemaReferences: ${canonicalReference}`],
  ['spread after metadata', `schemaReferences: [], ...{ schemaReferences: ${canonicalReference} }`],
  ['spread before metadata', `...{ schemaReferences: refs }, schemaReferences: ${canonicalReference}`],
  ['known literal spread', `...{ schemaReferences: ${canonicalReference} }`],
  ['duplicate metadata', `schemaReferences: refs, schemaReferences: ${canonicalReference}`],
  ['duplicate literal metadata', `schemaReferences: [], schemaReferences: ${canonicalReference}`],
  ['shorthand metadata', `schemaReferences`],
  ['getter metadata', `get schemaReferences() { return refs }`],
  ['method metadata', `schemaReferences() { return refs }`],
])('plugin reference allowlist rejects %s', (_name, metadata) => {
  const { root, put } = fixture(); roots.push(root)
  put('runtime.ts', `import custom from './plugin'\nexport default { plugins: [custom] }`)
  put('plugin.ts', `const field = 'note', key = 'schemaReferences', target = { entity: 'worker', field }, refs = [target], schemaReferences = refs;
export default { name: 'custom', version: '1', ${metadata} }`)
  const inventory = { ...pluginReferences(root), diagnostics: [] }
  expect(inventory.uncovered).toContainEqual(expect.objectContaining({ code: 'opaque-plugin-reference', kind: 'plugin', source: expect.objectContaining({ file: join(root, 'plugin.ts') }) }))
  for (const intent of [{ kind: 'remove_field', entity: 'worker', field: 'note' }, { kind: 'remove_entity', entity: 'worker' }] as const) {
    const result = validateRemoval(inventory, intent)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'opaque-plugin-reference', kind: 'plugin' }))
  }
})

test.each([
  `[{ entity: 'worker', 'field': 'note' }, { 'entity': 'worker' }]`,
  `[{ 'field': 'note', 'entity': 'worker' }, { entity: 'worker' }]`,
])('canonical literal plugin references resolve exact targets, spans and use sites: %s', metadata => {
  const { root, put } = fixture(); roots.push(root)
  const plugin = `export default { name: 'custom', version: '1', 'schemaReferences': ${metadata} }`
  const runtime = `import custom from './plugin'\nexport default { plugins: [custom] }`
  put('plugin.ts', plugin); put('runtime.ts', runtime)
  const result = pluginReferences(root)
  expect(result.uncovered).toEqual([])
  expect(result.references.map(r => r.target)).toEqual([{ entity: 'worker', field: 'note' }, { entity: 'worker' }])
  for (const [i, literal] of ["'note'", "'worker'"].entries()) {
    const ref = result.references[i]
    expect(ref).toMatchObject({ kind: 'plugin', owner: 'plugin:custom', entityContext: 'worker', source: { file: join(root, 'plugin.ts') } })
    expect(plugin.slice(ref.source.start, ref.source.end)).toBe(literal)
    expect(ref.useSites).toHaveLength(1)
    expect(runtime.slice(ref.useSites[0].source.start, ref.useSites[0].source.end)).toBe('custom')
  }
})

test('canonical empty plugin reference inventory has complete coverage', () => {
  const { root, put } = fixture(); roots.push(root)
  put('runtime.ts', `export default { plugins: [{ name: 'custom', version: '1', schemaReferences: [] }] }`)
  const inventory = { ...pluginReferences(root), diagnostics: [] }
  expect(inventory.references).toEqual([])
  expect(inventory.uncovered).toEqual([])
  expect(validateRemoval(inventory, { kind: 'remove_field', entity: 'worker', field: 'note' }).ok).toBe(true)
})

test('non-canonical metadata keeps independently known literal references alongside the coverage blocker', () => {
  const { root, put } = fixture(); roots.push(root)
  put('runtime.ts', `export default { plugins: [{ name: 'custom', version: '1', schemaReferences: [{ entity: 'worker', field: 'note' }, { entity: 'worker', ...target }], [key]: [] }] }`)
  const inventory = { ...pluginReferences(root), diagnostics: [] }
  expect(inventory.references.map(r => r.target)).toEqual([{ entity: 'worker', field: 'note' }])
  const result = validateRemoval(inventory, { kind: 'remove_field', entity: 'worker', field: 'note' })
  expect(result.ok).toBe(false)
  expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['removal-reference', 'opaque-plugin-reference']))
})
