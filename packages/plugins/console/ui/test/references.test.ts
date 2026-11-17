import { afterEach, expect, test } from 'vitest'
import { rmSync } from 'node:fs'
import { referenceInventory, validateRemoval } from '@workbasehq/core/references'
import { checkSources, normalise } from '../src/check'
import { consoleReferences } from '../src/references'
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
