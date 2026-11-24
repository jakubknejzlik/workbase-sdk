import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/references/analyze'
import { hash, removal, snapshot } from '../../src/references/model'
import { capture, sdkDependencyFiles, sdkPackages } from '../../src/references/capture'
import { templatePluginSnapshot } from './reference-template-fixture'
import { shippedSummaries } from '../../src/references/summaries'

const canonical = `[{ entity: 'worker', field: 'note' }]`
function graph(descriptor: string, prelude = '', options = {}) {
  return analyze(snapshot({ entry: 'runtime.ts', sources: { 'runtime.ts': `${prelude}\nexport default { plugins: [${descriptor}] }` } }), options)
}
function blocked(result: ReturnType<typeof graph>) {
  expect(removal(result, { entity: 'worker', field: 'note' }).safe).toBe(false)
  expect(removal(result, { entity: 'worker' }).safe).toBe(false)
}
const plugin = (members = `schemaReferences: ${canonical}`) => `{ name: 'custom', version: '1', ${members} }`

describe('strict metadata boundary (A03–A06, A19)', () => {
  const fixtures = [
    ['computed entity', `schemaReferences: [{ ['entity']: 'worker', field: 'note' }]`],
    ['computed field', `schemaReferences: [{ entity: 'worker', ['field']: 'note' }]`],
    ['spread member', `schemaReferences: [{ entity: 'worker', ...{ field: 'note' } }]`],
    ['unknown member', `schemaReferences: [{ entity: 'worker', typo: 'note' }]`],
    ['unknown member beside field', `schemaReferences: [{ entity: 'worker', field: 'note', extra: 'ignored' }]`],
    ['duplicate member', `schemaReferences: [{ entity: 'worker', field: 'name', field: 'note' }]`],
    ['shorthand member', `schemaReferences: [{ entity: 'worker', field }]`],
    ['getter member', `schemaReferences: [{ entity: 'worker', get field() { throw Error('never execute') } }]`],
    ['method member', `schemaReferences: [{ entity: 'worker', field() { return 'note' } }]`],
    ['numeric member', `schemaReferences: [{ entity: 'worker', 0: 'note' }]`],
    ['variable value', `schemaReferences: [{ entity: 'worker', field: field }]`],
    ['call value', `schemaReferences: [{ entity: 'worker', field: String('note') }]`],
    ['conditional value', `schemaReferences: [{ entity: 'worker', field: true ? 'note' : 'name' }]`],
    ['template value', 'schemaReferences: [{ entity: `worker`, field: `note` }]'],
    ['missing entity', `schemaReferences: [{ field: 'note' }]`],
    ['non-string value', `schemaReferences: [{ entity: 'worker', field: undefined }]`],
    ['variable item', `schemaReferences: [target]`], ['spread array', `schemaReferences: [...refs]`],
    ['array hole', `schemaReferences: [,]`], ['variable array', `schemaReferences: refs`],
    ['call array', `schemaReferences: refs.map(x => x)`], ['conditional array', `schemaReferences: true ? refs : []`],
    ['asserted array', `schemaReferences: ${canonical} as const`], ['parenthesized array', `schemaReferences: (${canonical})`],
    ['computed metadata', `['schemaReferences']: ${canonical}`], ['unknown computed override', `schemaReferences: [], [key]: ${canonical}`],
    ['computed before metadata', `[key]: refs, schemaReferences: ${canonical}`],
    ['spread after metadata', `schemaReferences: [], ...{ schemaReferences: ${canonical} }`],
    ['spread before metadata', `...{ schemaReferences: refs }, schemaReferences: ${canonical}`],
    ['known literal spread', `...{ schemaReferences: ${canonical} }`],
    ['duplicate metadata', `schemaReferences: refs, schemaReferences: ${canonical}`],
    ['duplicate literal metadata', `schemaReferences: [], schemaReferences: ${canonical}`],
    ['shorthand metadata', `schemaReferences`], ['getter metadata', `get schemaReferences() { return refs }`],
    ['method metadata', `schemaReferences() { return refs }`],
  ]
  it.each(fixtures)('%s cannot certify referenced removal', (_name, members) => {
    const result = graph(plugin(members), `const field = 'note', key = 'schemaReferences', target = { entity: 'worker', field }, refs = [target], schemaReferences = refs;`)
    blocked(result)
    if (!['computed before metadata', 'spread after metadata', 'known literal spread'].includes(_name)) expect(result.diagnostics.length).toBeGreaterThan(0)
  })
  it('keeps canonical siblings and never demotes unknown field to entity-only', () => {
    const result = graph(plugin(`schemaReferences: [${canonical.slice(1,-1)}, { entity: 'worker', field }]`))
    expect(result.references.map(ref => ref.field)).toEqual(['note'])
    expect(result.coverage.schema).toBe('invalid'); blocked(result)
  })
  it('entity-only blocks entity, permits all fields; [] is complete empty', () => {
    const result = graph(plugin(`schemaReferences: [{entity:'worker'}]`))
    expect(removal(result, { entity:'worker' }).safe).toBe(false)
    expect(removal(result, { entity:'worker', field:'note' }).safe).toBe(true)
    expect(removal(graph(plugin('schemaReferences: []')), { entity:'worker' }).safe).toBe(true)
    expect(removal(graph(plugin('')), { entity:'worker' }).safe).toBe(false)
  })
})

describe('ordered immutable resolution (A01,A02,A06,A13,A16,A17,A19)', () => {
  it.each([
    ['literal', plugin()],
    ['typed constant', 'p', `const p: unknown = (${plugin()} as const) satisfies unknown;`],
    ['local factory', 'make()', `function make() { function unrelated() { return nonsense() }; const p = ${plugin()}; return p }`],
    ['arrow factory', 'make()', `const make = () => (${plugin()});`],
    ['spread metadata', plugin(`...{schemaReferences:${canonical}}`)],
    ['neutral before', plugin(`...{configuration: mystery()}, schemaReferences:${canonical}`)],
    ['neutral after', plugin(`schemaReferences:${canonical}, ...{configuration: mystery()}`)],
    ['computed before', plugin(`[key]: mystery(), schemaReferences:${canonical}, name:'custom'`)],
  ])('%s resolves exact dependency and unrelated safe control', (_label, descriptor, prelude = '') => {
    const result = graph(descriptor, prelude)
    blocked(result)
    expect(result.coverage.schema).toBe('complete')
    expect(removal(result, { entity:'worker', field:'unrelated' }).safe).toBe(true)
  })
  it('resolves imported/re-exported aliases and runtime array/spread composition', () => {
    const result = analyze(snapshot({ entry:'runtime.ts', sources: {
      'runtime.ts': `import { p } from './barrel'; const plugins = [p]; const base={plugins}; export default {...base}`,
      'barrel.ts': `export { default as p } from './plugin'`,
      'plugin.ts': `const p = ${plugin()}; export default p`,
    }, resolutions:[{from:'runtime.ts',specifier:'./barrel',target:'barrel.ts',identity:'barrel'}, {from:'barrel.ts',specifier:'./plugin',target:'plugin.ts',identity:'plugin'}] }))
    blocked(result); expect(result.diagnostics).toEqual([])
    expect(result.references[0].span.file).toBe('plugin.ts')
    expect(result.registrations[0].span.file).toBe('runtime.ts')
  })
  it('retains runtime use sites when a shared registration array is imported',()=>{
    const result=analyze(snapshot({entry:'runtime.ts',sources:{
      'runtime.ts':`import plugins from './shared'; export default {plugins}`,
      'shared.ts':`const plugins=[${plugin()}]; export default plugins`,
    },resolutions:[{from:'runtime.ts',specifier:'./shared',target:'shared.ts',identity:'shared'}]}))
    blocked(result)
    expect(result.references[0].uses.some(use=>use.file==='runtime.ts')).toBe(true)
    expect(result.registrations[0].uses.some(use=>use.file==='runtime.ts')).toBe(true)
  })
  it('runtime overwrite resolves plugins only; later unknown keys block registrations', () => {
    const make = (text: string) => analyze(snapshot({entry:'runtime.ts',sources:{'runtime.ts':text}}))
    expect(removal(make(`export default {...unknown, plugins:[]}`), {entity:'worker'}).safe).toBe(true)
    expect(removal(make(`export default {plugins:[], ...unknown}`), {entity:'worker'}).safe).toBe(false)
    expect(make(`export default { ['plugins']: [] }`).coverage.registration).toBe('unresolved')
    expect(make(`export default { plugins:[${plugin()}, ...unknown] }`).references).toHaveLength(1)
  })
  it('handles primitive/array own keys and finite short-circuit configuration branches',()=>{
    for(const composition of ["...123", "...'abc'", "...[]", "...(flag && {configuration:run()})"]) {
      const result=graph(plugin(`schemaReferences:[], ${composition}`))
      expect(result.diagnostics).toEqual([]);expect(removal(result,{entity:'worker'}).safe).toBe(true)
    }
    const proven=graph('make()',`function make(){const flag=false; if(flag===true) return ${plugin()}; return ${plugin('schemaReferences:[]')}}`)
    expect(removal(proven,{entity:'worker'}).safe).toBe(true)
  })
  it('overwritten metadata disappears but errors and possible dependencies remain', () => {
    const cleared = graph(plugin(`...{schemaReferences:${canonical}}, schemaReferences:[]`))
    expect(cleared.references).toEqual([]); expect(removal(cleared,{entity:'worker'}).safe).toBe(true)
    const uncertain = graph(plugin(`schemaReferences:${canonical}, ...unknown`))
    expect(uncertain.references[0].certainty).toBe('possible'); blocked(uncertain)
    const malformed = graph(plugin(`...{schemaReferences:refs}, schemaReferences:[]`))
    expect(malformed.coverage.schema).toBe('invalid'); blocked(malformed)
  })
  it('projects equal branches without evaluating configuration', () => {
    const result = graph(plugin(`schemaReferences:${canonical}, ...(flag ? {configuration:run()} : {})`))
    expect(result.diagnostics).toEqual([])
    expect(removal(result,{entity:'worker',field:'other'}).safe).toBe(true)
    const same = graph('make()', `function make(){if (flag) return ${plugin()}; else return ${plugin()}}`)
    expect(same.coverage.schema).toBe('complete')
    const different = graph('make()', `function make(){if(flag) return ${plugin()}; return ${plugin('schemaReferences:[]')}}`)
    blocked(different); expect(different.references[0].certainty).toBe('possible')
  })
  it.each([
    ['fallthrough', 'make()', `function make(){if(flag) return ${plugin()}}`],
    ['cycle', 'make()', `function make(){return make()}`],
    ['mutation', 'p', `const p=${plugin('schemaReferences:[]')}; const alias=p; alias.schemaReferences=${canonical}`],
    ['escape', 'p', `const p=${plugin('schemaReferences:[]')}; mutate(p)`],
    ['let', 'p', `let p=${plugin()}`],
    ['getter', 'p', `const p={get schemaReferences(){throw new Error('never')}}`],
  ])('%s remains a gap', (_name, descriptor, prelude) => { blocked(graph(descriptor,prelude)) })
  it('bounds work, recursion and branches', () => {
    blocked(graph(plugin(), '', {maxNodes:1}))
    blocked(graph('make()', `function make(){return make()}`, {maxDepth:5}))
    blocked(graph(plugin(`schemaReferences:${canonical}, ...(a?{}:{configuration:1})`), '', {maxBranches:1}))
  })
  it('aggregates independent invalid source, dependency and gaps', () => {
    const result = analyze(snapshot({entry:'runtime.ts',sources:{'runtime.ts':`export default {plugins:[${plugin()}, ${plugin('schemaReferences:refs')}, unknown]}; const broken = ;`},failures:[{file:'other.ts',message:'unreadable'}]}))
    blocked(result); expect(result.references).toHaveLength(1)
    expect(result.diagnostics.map(d=>d.domain)).toEqual(expect.arrayContaining(['source','schema','registration']))
  })
  it('retains UTF-16 token spans, use sites, deterministic output and immutable input', () => {
    const input = snapshot({entry:'runtime.ts',sources:{'runtime.ts':`// 😀 é\nconst p=${plugin()}; export default {plugins:[p,p]}`}})
    const before=JSON.stringify(input), result=analyze(input)
    for(const ref of result.references) expect(input.sources[ref.span.file].slice(ref.span.start,ref.span.end)).toBe("'note'")
    expect(result.registrations).toHaveLength(2)
    expect(result.registrations[0].span.start).not.toBe(result.registrations[1].span.start)
    expect(analyze(input)).toEqual(result); expect(JSON.stringify(input)).toBe(before)
    expect(Object.isFrozen(result.references)).toBe(true)
  })
  it('unresolved side-effect imports are source failures even with an empty registration array',()=>{
    const result=analyze(snapshot({entry:'runtime.ts',sources:{'runtime.ts':`import './missing'; export default {plugins:[]}`}}))
    expect(result.coverage.registration).toBe('invalid'); blocked(result)
  })
  it('blocks inconsistent duplicate source/dependency captures',()=>{
    const input=snapshot({entry:'runtime.ts',sources:{'runtime.ts':'export default {plugins:[]}'},dependencies:{'runtime.ts':'different bytes'}})
    expect(input.failures[0].message).toContain('Inconsistent')
    blocked(analyze(input))
  })
  it('copies snapshot inputs before freezing them', () => {
    const raw = {'runtime.ts':'export default {plugins:[]}'}; const captured=snapshot({entry:'runtime.ts',sources:raw})
    raw['runtime.ts']='changed'; expect(captured.sources['runtime.ts']).not.toBe('changed')
  })
})

describe('source-bound shipped leaves (A07–A09,A18)', () => {
  const root=process.cwd()
  const captured = () => templatePluginSnapshot(root)
  it('accounts for nine template registrations and seven historical composition sites', () => {
    const input=captured(), result=analyze(input,{summaries:shippedSummaries})
    expect(input.failures).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.registrations).toHaveLength(9)
    expect(result.registrations.every(item=>item.summary && item.coverage.schema==='complete')).toBe(true)
    expect(result.coverage).toEqual({registration:'complete',schema:'complete',contract:'complete'})
    expect(removal(result,{entity:'worker',field:'note'}).safe).toBe(true)
    expect(removal(result,{entity:'unrelated'}).safe).toBe(true)
    expect(result.contracts.length).toBeGreaterThan(9)
  })
  it('rejects stale source/dependencies/resolution and missing bytes', () => {
    const input=captured(), leaf=shippedSummaries[0]
    for(const altered of [
      snapshot({...input,sources:{...input.sources,[leaf.file]: input.sources[leaf.file]+'\n// changed'}}),
      snapshot({...input,dependencies:{...input.dependencies,'bun.lock':'changed'}}),
      snapshot({...input,resolutions:input.resolutions.map(edge=>edge.from===leaf.file ? {...edge,identity:'replacement'}:edge)}),
      snapshot({...input,dependencies:{}}),
    ]) expect(removal(analyze(altered,{summaries:shippedSummaries}),{entity:'worker'}).safe).toBe(false)
    expect(hash(input.sources[leaf.file])).toBe(leaf.sourceHash)
  })
  it('does not trust lookalikes by helper, name or package prefix', () => {
    blocked(graph(`builtinPlugin(${plugin()})`, 'function builtinPlugin(x){return unknown(x)}'))
    const result=analyze(snapshot({entry:'runtime.ts',sources:{'runtime.ts':`import {createIdentity} from '@workbasehq/plugins/lookalike'; export default {plugins:[createIdentity()]}`,'fake.ts':`export function createIdentity(){return ${plugin()}}`},resolutions:[{from:'runtime.ts',specifier:'@workbasehq/plugins/lookalike',target:'fake.ts',identity:'custom'}]}),{summaries:shippedSummaries})
    blocked(result); expect(result.registrations[0].summary).toBeUndefined()
  })
  it('caller-added dependencies and unresolved overrides remain effective', () => {
    const input=captured(), entry=input.entry, original=input.sources[entry]
    for(const override of [`schemaReferences:${canonical}`, '...unknown']) {
      const changed=snapshot({...input,sources:{...input.sources,[entry]:original.replace('createIdentity(),',`{...createIdentity(), ${override}},`)}})
      const result=analyze(changed,{summaries:shippedSummaries}); blocked(result)
      expect(result.registrations).toHaveLength(9)
    }
  })
  it('contract-only uncertainty stays separate from schema coverage', () => {
    const result=graph('make()', `function make(){return flag ? ${plugin("schemaReferences:[], requires:{worker:'^1'}")} : ${plugin('schemaReferences:[]')}}`)
    expect(result.coverage.schema).toBe('complete')
    expect(result.coverage.contract).toBe('unresolved')
    expect(removal(result,{entity:'worker'}).safe).toBe(true)
    const malformed=graph(plugin('schemaReferences:[], requires:null'))
    expect(removal(malformed,{entity:'worker'}).safe).toBe(false)
    const invalid=graph(plugin("schemaReferences:[], requires:{worker:'^1'}"))
    expect(invalid.coverage.schema).toBe('complete')
    expect(removal(invalid,{entity:'worker'}).safe).toBe(false)
  })
  it('preserves known dependency beside independent descriptor and registration uncertainty', () => {
    const result=graph(`${plugin()}, ${plugin('schemaReferences:[], ...unknown')}, mystery()`)
    blocked(result)
    expect(result.references.some(ref=>ref.certainty==='definite'&&ref.field==='note')).toBe(true)
    expect(result.diagnostics.map(item=>item.domain)).toEqual(expect.arrayContaining(['registration','schema']))
  })
  it.each([
    `const p=${plugin('schemaReferences:[]')}; const {schemaReferences:r}=p; r.push({entity:'worker',field:'note'})`,
    `const p=${plugin('schemaReferences:[]')}; const box={p}; mutate(box)`,
    `const p=${plugin('schemaReferences:[]')}; mutate((p as unknown))`,
    `const p=${plugin('schemaReferences:[]')}; const a=[p]; mutate(a)`,
  ])('rejects nested/destructured/escaped mutable aliases', prelude => blocked(graph('p',prelude)))
  it('detects mutation through imported re-export aliases in side-effect modules', () => {
    const result=analyze(snapshot({entry:'runtime.ts',sources:{
      'runtime.ts':`import p from './plugin'; import './mutator'; export default {plugins:[p]}`,
      'plugin.ts':`export default ${plugin('schemaReferences:[]')}`,
      'barrel.ts':`export {default as p} from './plugin'`,
      'mutator.ts':`import {p} from './barrel'; p.schemaReferences.push({entity:'worker',field:'note'})`,
    },resolutions:[{from:'runtime.ts',specifier:'./plugin',target:'plugin.ts',identity:'plugin'}, {from:'runtime.ts',specifier:'./mutator',target:'mutator.ts',identity:'mutator'}, {from:'barrel.ts',specifier:'./plugin',target:'plugin.ts',identity:'plugin'}, {from:'mutator.ts',specifier:'./barrel',target:'barrel.ts',identity:'barrel'}]}))
    blocked(result)
  })
  it('retains invalid computed metadata/prototype declarations even with explicit later values', () => {
    blocked(graph(plugin("['schemaReferences']:refs, schemaReferences:[]")))
    blocked(graph(plugin("__proto__:unknown, schemaReferences:[], provides:{}, requires:{}, optionalRequires:{}")))
  })
  it('reports unresolved reexports and module exhaustion', () => {
    const input=snapshot({entry:'runtime.ts',sources:{'runtime.ts':`export {default} from './missing'`}})
    expect(analyze(input).coverage.registration).toBe('unresolved')
    expect(analyze(input,{maxModules:0}).coverage.registration).toBe('invalid')
  })
  it('missing entry is a source failure, never empty complete plugins', () => {
    const input=capture({root,entry:'nonexistent-reference-runtime.ts'})
    expect(input.failures).toHaveLength(1)
    expect(removal(analyze(input),{entity:'worker'}).safe).toBe(false)
  })
})


describe('read-only source capture',()=>{
  it('captures invalid encoding, missing dependency and ambiguous import failures without losing known facts',()=>{
    const root=mkdtempSync(join(tmpdir(),'reference-capture-'))
    try {
      writeFileSync(join(root,'runtime.ts'),`import plugin from './plugin'; export default {plugins:[${plugin()},plugin]}`)
      writeFileSync(join(root,'plugin.ts'),new Uint8Array([0xff,0xfe]))
      const input=capture({root,entry:'runtime.ts',dependencies:['missing.lock']})
      expect(input.failures.map(item=>item.file)).toEqual(expect.arrayContaining(['plugin.ts','missing.lock']))
      const result=analyze(input); blocked(result); expect(result.references).toHaveLength(1)
      writeFileSync(join(root,'plugin.ts'),`export default ${plugin('schemaReferences:[]')}`)
      writeFileSync(join(root,'plugin.tsx'),`export default ${plugin('schemaReferences:[]')}`)
      const ambiguous=capture({root,entry:'runtime.ts'})
      expect(ambiguous.resolutions.find(edge=>edge.specifier==='./plugin')?.target).toBeUndefined()
      blocked(analyze(ambiguous))
    } finally {rmSync(root,{recursive:true,force:true})}
  })
  it('rejects a resolution symlink outside the selected root and records module budget failure',()=>{
    const parent=mkdtempSync(join(tmpdir(),'reference-boundary-')), root=join(parent,'selected')
    try {
      mkdirSync(root)
      writeFileSync(join(parent,'outside.ts'),`export default ${plugin('schemaReferences:[]')}`)
      writeFileSync(join(root,'runtime.ts'),`import p from './plugin'; export default {plugins:[p]}`)
      symlinkSync(join(parent,'outside.ts'),join(root,'plugin.ts'))
      const input=capture({root,entry:'runtime.ts'})
      expect(input.resolutions[0].target).toBeUndefined(); blocked(analyze(input))
      expect(capture({root,entry:'runtime.ts',maxModules:0}).failures[0].message).toContain('budget')
    } finally {rmSync(parent,{recursive:true,force:true})}
  })
})
