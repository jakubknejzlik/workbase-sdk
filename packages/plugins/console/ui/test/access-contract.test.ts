import { rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import { checkSources, normalise, canonicalJSON } from '../src/check'
import { entityDetailPage, entityEditPage, p, slot } from '../src/index'
import { extractManifest } from '../src/vite'
import { requiredKeys, actionFamilies } from '../src/validate'
import { fixture, instanceFixture, sdk } from './fixture'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
test('p.access is plain additive JSON, valid only as an implicit prop in a record slot', () => {
  expect(JSON.parse(JSON.stringify(p.access()))).toEqual({ kind: 'access' })
  const f = fixture(); roots.push(f.root)
  rmSync(join(f.root, 'ui/index.ts'))
  f.put('ui/$workerId/index.ts', `import { entityDetailPage } from '${sdk}'; export default entityDetailPage('worker', {title:'sample.detail',recordParam:'workerId'})`)
  f.put('ui/-slots.ts', `import { defineSlots } from '${sdk}'; export default defineSlots({})`)
  const schema = { worker: { fields: { name: { type: 'text' }, user: { type: 'ref', userLink: true } } } }
  const component = () => null, slots = { card: { contexts: ['record'], props: { access: p.access(), account: p.field('userLink') }, component } }
  const page = entityDetailPage('worker', { title: 'sample.detail', recordParam: 'workerId', layout: [slot('card', { account: 'user' })] })
  const sources = checkSources(f.root)
  const manifest = normalise(sources, { 'ui/$workerId/index.ts': page, 'ui/-slots.ts': slots }, schema, 'hash')
  expect(manifest.slots.card.props.access).toEqual({ kind: 'access' }); expect(manifest.routes[0].layout).toEqual([slot('card', { account: 'user' })])
  expect(() => normalise(sources, { 'ui/$workerId/index.ts': { ...page, layout: [slot('card', { account: 'user', access: 'forged' })] }, 'ui/-slots.ts': slots }, schema, 'hash')).toThrow('implicit')
  expect(() => normalise(sources, { 'ui/$workerId/index.ts': entityEditPage('worker', { title: 'sample.edit', recordParam: 'workerId', layout: page.layout }), 'ui/-slots.ts': slots }, schema, 'hash')).toThrow('context')
})
test('Instance can register the SDK AccessCard directly; extraction stubs it without evaluating React', async () => {
  const f = instanceFixture(); roots.push(f.root)
  f.put('ui/-slots.ts', `import { defineSlots, p } from '${sdk}'\nimport { AccessCard } from '${sdk}/react'\nexport default defineSlots({ fieldValue: { contexts: ['record'], props: { value: p.field('userLink'), access: p.access() }, component: AccessCard } })`)
  const manifest = await extractManifest(f.root)
  expect(manifest.slots.fieldValue.props.access).toEqual({ kind: 'access' })
})
test('existing committed manifest v3 bytes stay identical to base 369ae2e', async () => {
  const root = resolve('packages/plugins/console/ui/fixture')
  const output = execFileSync('bun', ['-e', "import { extractManifest } from './packages/plugins/console/ui/src/vite'; import { canonicalJSON } from './packages/plugins/console/ui/src/client'; console.log(canonicalJSON(await extractManifest('packages/plugins/console/ui/fixture')))"], { cwd: root.replace('/packages/plugins/console/ui/fixture', ''), encoding: 'utf8' })
  // Independent checked-in digest was captured from the base extraction before adding p.access.
  expect((await import('node:crypto')).createHash('sha256').update(output.trim()).digest('hex')).toBe('f7ea9349ee329ce607847304ecbcde881c7531055a649104050a30794b19e051')
  expect(canonicalJSON(await extractManifest(root))).toBe(output.trim())
})
test('other action reasons belong to Instance ui dictionaries; access reasons belong to SDK', () => {
  const config = { entities: {}, effectiveAccess: { actions: [{ conditions: [{ reason: 'custom.blocked' }, { reason: 'access.not_linked' }] }] } }
  const manifest = { version: 3 as const, configHash: 'hash', entities: {}, routes: [], nav: [], slots: {}, keys: {} }
  const required = requiredKeys(config as unknown as Parameters<typeof requiredKeys>[0], manifest, { keys: new Map(), families: new Set(), findings: [] }, {})
  expect([...required.keys()].sort()).toEqual(['sdk:access.not_linked', 'ui:custom.blocked'])
})
test('record reasons consume registered ui families without treating SDK access reasons as authored families', () => {
  expect(actionFamilies(['state.reason.locked', 'access.not_linked'], { 'state.reason': ['locked', 'empty'], access: ['not_linked'], 'unused.reason': ['locked'] })).toEqual(['state.reason'])
  expect(actionFamilies(['state.reason.unknown'], { 'state.reason': ['locked'] })).toEqual([])
})
