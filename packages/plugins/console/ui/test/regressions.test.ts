import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, test } from 'vitest'
import { checkSources, normalise, canonicalJSON } from '../src/check'
import { page } from '../src/index'
import { extractManifest } from '../src/vite'
import { fixture, sdk } from './fixture'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function setup() { const f = fixture(); roots.push(f.root); return f }
function roundTrip<T>(value: T): T { return JSON.parse(JSON.stringify(value)) }
function expectNullObjects(value: unknown) {
  if (!value || typeof value !== 'object') return
  if (!Array.isArray(value)) expect(Object.getPrototypeOf(value)).toBeNull()
  Object.values(value).forEach(expectNullObjects)
}

test.each([
  ['statement-type-schema', "import type worker from '../schema/worker'; type Worker = typeof worker;"],
  ['schema-type-query', "type Worker = typeof import('../schema/worker').default;"],
  ['schema-import-type', "type Worker = import('../schema/types').Worker;"],
])('%s is erased and never evaluated', async (_name, type) => {
  const { root, put } = setup()
  put('schema/types.ts', "throw new Error('SCHEMA_EXECUTED'); export type Worker = {fields:{name:{type:'text'}}}")
  const text = `${type} import {page,layout} from '${sdk}'; const fields=layout<Worker>(['name']); export default page({title:'worker.title',entity:'worker',layout:fields})`
  put('ui/index.ts', text)
  const emitted = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, verbatimModuleSyntax: true, isolatedModules: true } }).outputText
  expect(emitted).not.toContain('../schema/')
  const sources = checkSources(root)
  expect([...sources.modules.keys()].some(file => file.startsWith(join(root, 'schema/')))).toBe(false)
  expect((await extractManifest(root)).routes[0].layout).toEqual(['name'])
})

test('defaults-page-nav-slots survive strict parsing', async () => {
  const { root, put } = setup()
  put('ui/-slots.ts', `import {defineSlots,p} from '${sdk}'; export default defineSlots({sample:{contexts:['record'],props:{visible:p.boolean({default:true}),other:p.boolean(),field:p.field('text'),condition:p.when()},component:()=>null}})`)
  put('ui/nav.ts', `import {defineNav,link} from '${sdk}'; export default defineNav([{title:'worker.nav',target:link('worker','list')}])`)
  put('ui/index.ts', `import {entityListPage,param,layout} from '${sdk}'; export default entityListPage('worker',{title:'worker.list',search:{q:param.string({default:''}),n:param.int({min:1,default:5}),s:param.string(),i:param.int()},layout:layout([])})`)
  const manifest = await extractManifest(root)
  expect(manifest.routes[0].search).toEqual({ q: { kind: 'string', default: '' }, n: { kind: 'int', min: 1, default: 5 }, s: { kind: 'string' }, i: { kind: 'int' } })
  expect(manifest.slots.sample.props.visible).toEqual({ kind: 'boolean', default: true })
  expect(manifest.nav[0].link).toEqual({ to: '/', bind: {} })
  expect(roundTrip(manifest)).toEqual(manifest)
})

for (const key of ['constructor', 'prototype']) {
  test(`search-key-${key} round-trips as data`, async () => {
    const { root, put } = setup()
    put('ui/index.ts', `import {page,param} from '${sdk}'; export default page({title:'sample.title',search:{${key}:param.string({default:'all'})}})`)
    const manifest = await extractManifest(root)
    expect(roundTrip(manifest).routes[0].search[key]).toEqual({ kind: 'string', default: 'all' })
    expectNullObjects(manifest)
  })
  test(`slot-name-${key} round-trips and resolves`, async () => {
    const { root, put } = setup()
    put('ui/-slots.ts', `import {defineSlots} from '${sdk}'; export default defineSlots({${key}:{contexts:['record'],props:{},component:()=>null}})`)
    put('ui/index.ts', `import {page,slot} from '${sdk}'; export default page({title:'sample.title',layout:[slot('${key}')]})`)
    const manifest = await extractManifest(root)
    expect(roundTrip(manifest).slots[key]).toEqual({ contexts: ['record'], props: {} })
    expectNullObjects(manifest)
  })
  test(`slot-prop-${key} round-trips and resolves`, async () => {
    const { root, put } = setup()
    put('ui/-slots.ts', `import {defineSlots,p} from '${sdk}'; export default defineSlots({sample:{contexts:['record'],props:{${key}:p.field('text')},component:()=>null}})`)
    put('ui/index.ts', `import {page,slot} from '${sdk}'; export default page({title:'worker.title',entity:'worker',layout:[slot('sample',{${key}:'name'})]})`)
    const manifest = await extractManifest(root)
    expect(roundTrip(manifest).slots.sample.props[key]).toEqual({ kind: 'field', type: 'text' })
    expect(roundTrip(manifest).routes[0].layout).toEqual([{ kind: 'slot', id: 'sample', props: { [key]: 'name' } }])
    expectNullObjects(manifest)
  })
  test(`field-name-${key} remains valid`, () => {
    const { root } = setup()
    const schema = { worker: { fields: { [key]: { type: 'text' } } } }
    const manifest = normalise(checkSources(root), { 'ui/index.ts': page({ title: 'sample.title', entity: 'worker', layout: [key] }) }, schema, 'hash')
    expect(roundTrip(manifest).routes[0].layout).toEqual([key])
  })
}

test('component-real-packages are checked and stubbed', async () => {
  const { root, put } = setup()
  for (const name of ['react', '@tanstack/react-router']) {
    const target = join(root, 'node_modules', name)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(resolve('packages/frontend-console/node_modules', name), target, 'dir')
  }
  put('ui/-components/Widget.tsx', `import React from 'react'; import {Link} from '@tanstack/react-router'; import {page} from '${sdk}'; const browser=window; throw new Error('COMPONENT_EXECUTED'); export default function Widget(){return <Link to="/">{page({title:'sample.title'}).title}</Link>}`)
  put('ui/index.ts', `import {customPage} from '${sdk}'; import Widget from './-components/Widget'; export default customPage({title:'sample.title',uses:[],component:Widget})`)
  expect((await extractManifest(root)).routes[0].kind).toBe('customPage')
})

test.each(['sdk-package', 'sdk-relative', 'vite-virtual', 'vite-client', 'fs-sdk', 'query-local'])('%s import boundary is preserved', async name => {
  const { root, put } = setup()
  const source = resolve('packages/plugins/console/ui/src/index.ts')
  const ids: Record<string, string> = { 'sdk-package': sdk, 'sdk-relative': relative(join(root, 'ui'), source), 'vite-virtual': 'virtual:fixture', 'vite-client': '/@vite/client', 'fs-sdk': '/@fs/' + source.slice(1), 'query-local': './-data.ts?raw' }
  put('ui/-data.ts', `throw new Error('UNCHECKED_EXECUTED'); export const page=()=>null`)
  put('ui/index.ts', `import {page} from '${ids[name]}'; export default page({title:'sample.title'})`)
  if (name === 'sdk-package') expect((await extractManifest(root)).routes[0].title).toBe('sample.title')
  else {
    const error = await extractManifest(root).catch(error => error)
    expect(error.message).toMatch(/index.ts:\d+:\d+:/)
    expect(error.message).not.toContain('UNCHECKED_EXECUTED')
  }
})

test.each(['constructor', 'prototype'])('missing %s slot cannot resolve through Object.prototype', key => {
  const { root } = setup()
  expect(() => normalise(checkSources(root), { 'ui/index.ts': page({ title: 'sample.title', layout: [{ kind: 'slot', id: key, props: {} }] }) }, {}, 'hash')).toThrow(`Unknown slot ${key}`)
})

test.each(['constructor', 'prototype'])('missing %s field cannot resolve through Object.prototype', key => {
  const { root } = setup()
  expect(() => normalise(checkSources(root), { 'ui/index.ts': page({ title: 'worker.title', entity: 'worker', layout: [key] }) }, { worker: { fields: {} } }, 'hash')).toThrow(`Unknown or wrong field ${key}`)
})

test('empty registries have no inherited manifest keys', async () => {
  const { root } = setup()
  const manifest = await extractManifest(root)
  expectNullObjects(manifest)
  expect(manifest.slots.constructor).toBeUndefined()
  expect(manifest.routes[0].search.constructor).toBeUndefined()
  expect(canonicalJSON(roundTrip(manifest))).toBe(canonicalJSON(manifest))
})
