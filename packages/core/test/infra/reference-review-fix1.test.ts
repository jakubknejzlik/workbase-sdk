import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import fixtures from './reference-review-fix1-fixtures.json'
import { analyze } from '../../src/references/analyze'
import { capture } from '../../src/references/capture'
import { removal, snapshot } from '../../src/references/model'

// Exact review wr-bd730630 inputs, including both transitive source fixtures.
// Controls are re-analyzed here rather than asserting recorded review outputs.
describe('review wr-bd730630 regressions (F1–F6)', () => {
  it.each(fixtures)('$name', fixture => {
    const root = mkdtempSync(join(tmpdir(), 'reference-fix1-'))
    try {
      writeFileSync(join(root, 'runtime.ts'), fixture.text)
      if (fixture.side !== undefined) writeFileSync(join(root, 'side.ts'), fixture.side)
      const graph = analyze(capture({ root, entry: 'runtime.ts' }))
      const safe = fixture.name === 'ordinary-safe-control'
      expect(removal(graph, { entity: 'worker', field: 'note' }).safe).toBe(safe)
      expect(removal(graph, { entity: 'worker' }).safe).toBe(safe)
      if (safe) {
        expect(graph.diagnostics).toEqual([])
        expect(graph.coverage).toEqual({ registration: 'complete', schema: 'complete', contract: 'complete' })
      } else if (fixture.name.startsWith('unloaded-')) {
        expect(graph.diagnostics.some(item => item.domain === 'source')).toBe(true)
        expect(graph.coverage.schema).toBe('invalid')
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

const empty = `{name:'custom',schemaReferences:[]}`
const referenced = `{name:'custom',schemaReferences:[{entity:'worker',field:'note'}]}`
const inspect = (text: string) => analyze(snapshot({entry:'runtime.ts',sources:{'runtime.ts':text}}))
describe('resolved factory alternatives and defaults', () => {
  it('blocks returned aliases invoked through an untracked callee projection', () => {
    const graph=inspect(`const p=${empty}; function get(){return p}; ([get][0])().schemaReferences.push({entity:'worker',field:'note'}); export default {plugins:[p]}`)
    expect(removal(graph,{entity:'worker',field:'note'}).safe).toBe(false)
  })
  it('preserves exact imported factory returns when all consumers are immutable', () => {
    const graph=analyze(snapshot({entry:'runtime.ts',sources:{
      'runtime.ts':`import {make} from './barrel'; const registrations=[make()]; export default {plugins:registrations}`,
      'barrel.ts':`export {make} from './plugin'`,
      'plugin.ts':`const descriptor=${referenced}; export function make(){return descriptor}`,
    },resolutions:[{from:'runtime.ts',specifier:'./barrel',target:'barrel.ts',identity:'barrel'}, {from:'barrel.ts',specifier:'./plugin',target:'plugin.ts',identity:'plugin'}]}))
    expect(graph.diagnostics).toEqual([])
    expect(graph.references).toHaveLength(1)
    expect(removal(graph,{entity:'worker',field:'note'}).safe).toBe(false)
    expect(removal(graph,{entity:'worker',field:'unrelated'}).safe).toBe(true)
  })
  it('projects distinct functions before comparing equal metadata', () => {
    const graph=inspect(`const make=flag ? ()=>(${empty}) : ()=>(${empty}); export default {plugins:[make()]}`)
    expect(graph.diagnostics).toEqual([])
    expect(removal(graph,{entity:'worker'}).safe).toBe(true)
  })
  it('keeps dependency facts from differing function projections', () => {
    const graph=inspect(`const make=flag ? ()=>(${empty}) : ()=>(${referenced}); export default {plugins:[make()]}`)
    expect(graph.references).toEqual(expect.arrayContaining([expect.objectContaining({entity:'worker',field:'note'})]))
    expect(removal(graph,{entity:'worker'}).safe).toBe(false)
  })
  it.each(['', 'undefined', 'mystery'])('retains a dependency-bearing default for argument %s', argument => {
    const graph=inspect(`function make(flag=true){return flag ? ${referenced} : ${empty}}; export default {plugins:[make(${argument})]}`)
    expect(removal(graph,{entity:'worker',field:'note'}).safe).toBe(false)
  })
  it('resolves a proven false argument without applying its default', () => {
    const graph=inspect(`function make(flag=true){return flag ? ${referenced} : ${empty}}; export default {plugins:[make(false)]}`)
    expect(graph.diagnostics).toEqual([])
    expect(removal(graph,{entity:'worker'}).safe).toBe(true)
  })
  it('resolves module and factory-local undefined bindings before the intrinsic', () => {
    for (const prelude of ['const undefined=true; function make(){', 'function make(){const undefined=true;']) {
      const graph=inspect(`${prelude}return undefined ? ${referenced} : ${empty}}; export default {plugins:[make()]}`)
      expect(removal(graph,{entity:'worker',field:'note'}).safe).toBe(false)
      expect(graph.references).toHaveLength(1)
    }
  })
  it('preserves fallthrough through nested branch continuations', () => {
    const graph=inspect(`function make(){if(a) return ${empty}; const x=1; if(b) return ${empty}; const y=2}; export default {plugins:[make()]}`)
    expect(removal(graph,{entity:'worker'}).safe).toBe(false)
  })
  it.each([
    `function make(){function undefined(){}; return undefined ? ${referenced} : ${empty}}`,
    `function make(){return undefined ? ${referenced} : ${empty}; const undefined=false}`,
    `function make(undefined=undefined){return undefined ? ${empty} : ${referenced}}`,
  ])('keeps unresolved lexical undefined declarations blocking: %s', declaration => {
    const graph=inspect(`${declaration}; export default {plugins:[make()]}`)
    expect(removal(graph,{entity:'worker',field:'note'}).safe).toBe(false)
  })
})
