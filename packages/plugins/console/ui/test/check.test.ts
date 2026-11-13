import { rmSync } from 'node:fs'
import { afterEach, expect, test } from 'vitest'
import { checkSources, normalise, SourceError, canonicalJSON, manifestHash } from '../src/check'
import { page, customPage, entityDetailPage, entityEditPage, entityListPage, param, p, slot } from '../src/index'
import { fixture, declaration, sdk, forbidden } from './fixture'
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function setup() { const f = fixture(); roots.push(f.root); return f }
const schema = { worker: { fields: { name: { type: 'text' } } } }
test.each(forbidden)('import boundary before evaluation: %s', (_name, edge, file, content) => {
  const { root, put } = setup()
  put('ui/index.ts', edge + '\nthrow new Error("EVALUATED")\n' + declaration)
  if (file) put(file, 'throw new Error("EVALUATED")\n' + content)
  let caught: unknown
  try { checkSources(root) } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(SourceError)
  expect(String(caught)).toMatch(/:\d+:\d+:/)
  expect(String(caught)).not.toContain('EVALUATED')
})
test('named SDK binding and type-only schema import preserve trust', () => {
  const { root, put } = setup()
  put('ui/index.ts', `import type worker from '../schema/worker'\nimport { page as p } from '${sdk}'\nexport default p({ title: 'sample.title' })`)
  expect(checkSources(root).entries[0].helper).toBe('page')
  put('ui/index.ts', `const page = (x: unknown) => x; export default page({ title: 'sample.title' })`)
  expect(() => checkSources(root)).toThrow(SourceError)
})
test('forged default object, extra keys and non-JSON values are rejected', () => {
  const { root, put } = setup()
  put('ui/index.ts', `export default { kind: 'page', title: 'sample.title' }`)
  expect(() => checkSources(root)).toThrow(SourceError)
  put('ui/index.ts', declaration)
  for (const value of [ { ...page({ title: 'sample.title' }), extra: true }, { ...page({ title: 'sample.title' }), uses: [undefined] }, { ...page({ title: 'sample.title' }), layout: [new Date()] }, { ...page({ title: 'sample.title' }), component: 'fake' }, { ...page({ title: 'sample.title' }), component: () => null } ]) {
    expect(() => normalise(checkSources(root), { 'ui/index.ts': value }, schema, 'hash')).toThrow(SourceError)
  }
})
test.each([
  ['unknown uses', { uses: ['worker.missing'] }],
  ['unknown slot', { layout: [slot('missing')] }],
  ['param set differs', { params: { id: param.id('worker') } }],
  ['malformed params', { search: { n: { kind: 'int', min: 2, default: 1 } } }],
  ['action node', { layout: [{ kind: 'action', id: 'save' }] }],
  ['query binding', { data: { records: { kind: 'query' } } }],
])('post-evaluation at default call: %s', (_name, input) => {
  const { root } = setup()
  expect(() => normalise(checkSources(root), { 'ui/index.ts': page({ title: 'sample.title', ...input } as any) }, schema, 'hash')).toThrow(/index.ts:2:16:/)
})
test.each(['query', 'action'])('%s is a source error', name => {
  const { root, put } = setup()
  put('ui/index.ts', `${name}();\n${declaration}`)
  expect(() => checkSources(root)).toThrow(/not in slice 7/)
})
test('collisions after parameter normalization are located', () => {
  const { root, put } = setup()
  put('ui/$id.ts', declaration); put('ui/$workerId.ts', declaration)
  const values = { 'ui/index.ts': page({ title: 'sample.title' }), 'ui/$id.ts': entityDetailPage('worker', { title: 'worker.detail', recordParam: 'id' }), 'ui/$workerId.ts': entityEditPage('worker', { title: 'worker.edit', recordParam: 'workerId' }) }
  expect(() => normalise(checkSources(root), values, schema, 'hash')).toThrow(/Route collision/)
})
test.each(['context', 'prop', 'field'])('unknown slot %s is rejected', kind => {
  const { root, put } = setup()
  put('ui/-slots.ts', `import { defineSlots } from '${sdk}'; export default defineSlots({})`)
  const values = {
    'ui/index.ts': page({ title: 'worker.detail', entity: 'worker', layout: [slot('sample', { name: kind === 'field' ? 'absent' : 'name', ...(kind === 'prop' ? { extra: true } : {}) })] }),
    'ui/-slots.ts': { sample: { contexts: [kind === 'context' ? 'form' : 'record'], props: { name: p.field('text') }, component: () => null } },
  }
  expect(() => normalise(checkSources(root), values, schema, 'hash')).toThrow(SourceError)
})
test('nav target must resolve to a page', () => {
  const { root, put } = setup()
  put('ui/nav.ts', `import { defineNav } from '${sdk}'; export default defineNav([])`)
  expect(() => normalise(checkSources(root), { 'ui/index.ts': page({ title: 'sample.title' }), 'ui/nav.ts': [{ title: 'worker.nav', target: { entity: 'worker', mode: 'list' } }] }, schema, 'hash')).toThrow(/nav.ts:1:.*Missing/)
})
test('manifest is deterministic data; component functions are the only stripped values', () => {
  const { root, put } = setup()
  put('ui/index.ts', `import { customPage } from '${sdk}'; export default customPage({ title: 'sample.title', uses: [], component: () => null })`)
  const values = { 'ui/index.ts': customPage({ title: 'sample.title', uses: [], component: () => null }) }
  const first = normalise(checkSources(root), values, schema, 'hash'), second = normalise(checkSources(root), values, schema, 'hash')
  expect(canonicalJSON(first)).toBe(canonicalJSON(second))
  expect(manifestHash(first)).toBe(manifestHash(second))
  expect(canonicalJSON(first)).not.toContain('component')
})
test('entity detail links bind the declared workerId', () => {
  const { root, put } = setup()
  put('ui/workers/index.ts', declaration); put('ui/workers/$workerId/index.ts', declaration)
  const manifest = normalise(checkSources(root), { 'ui/index.ts': page({ title: 'sample.title' }), 'ui/workers/index.ts': entityListPage('worker', { title: 'worker.list' }), 'ui/workers/$workerId/index.ts': entityDetailPage('worker', { title: 'worker.detail', recordParam: 'workerId' }) }, schema, 'hash')
  expect(manifest.routes.find(r => r.mode === 'list')!.links.detail).toEqual({ to: '/workers/$workerId', bind: { workerId: 'record.id' } })
})
