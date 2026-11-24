import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import fixtures from './reference-review-fix2-fixtures.json'
import { analyze } from '../../src/references/analyze'
import { capture } from '../../src/references/capture'
import { removal } from '../../src/references/model'

const empty = `{name:'custom',version:'1.0.0',schemaReferences:[]}`
const referenced = `{name:'custom',version:'1.0.0',schemaReferences:[{entity:'worker',field:'note'}]}`
const select = `return undefined ? ${referenced} : ${empty}`
const descriptor = `const p:{name:string;version:string;schemaReferences:{entity:string;field:string}[]}=${empty};`
const mutate = `get().schemaReferences.push({entity:'worker',field:'note'}); export default {plugins:[descriptor]}`
const extra = [
  { name:'F1-exported-class-alias', text:`import {Owner,descriptor} from './side'; Owner.get().schemaReferences.push({entity:'worker',field:'note'}); export default {plugins:[descriptor]}`,
    side:`${descriptor} export class Owner {static get(){return p}}; export const descriptor=p` },
  { name:'F1-default-class-alias', text:`import Owner,{descriptor} from './side'; Owner.get().schemaReferences.push({entity:'worker',field:'note'}); export default {plugins:[descriptor]}`,
    side:`${descriptor} export default class Owner {static get(){return p}}; export const descriptor=p` },
  { name:'F1-exported-class-field-alias', text:`import {Owner,descriptor} from './side'; Owner.value.schemaReferences.push({entity:'worker',field:'note'}); export default {plugins:[descriptor]}`,
    side:`${descriptor} export class Owner {static value=p}; export const descriptor=p` },
  { name:'F1-exported-enum-member-alias', text:`import {Owner,descriptor} from './side'; (Owner.value as any).schemaReferences.push({entity:'worker',field:'note'}); export default {plugins:[descriptor]}`,
    side:`${descriptor} export enum Owner {value=p as any}; export const descriptor=p` },
  { name:'F1-named-function-default-import', text:`import get,{descriptor} from './side'; ${mutate}`,
    side:`${descriptor} export function get(){return p}; export {get as default}; export const descriptor=p` },
  ...[
    ['class','class undefined {}'],
    ['enum','enum undefined {flag=1}'],
    ['namespace','namespace undefined {export const flag=true}'],
    ['rest-pattern','const {flag,...undefined}={flag:false,truthy:true}'],
    ['mixed-pattern','const [{flag:[undefined]}]=[{flag:[true]}]'],
    ['elided-pattern','const [,undefined]=[false,true]'],
  ].map(([name,prelude])=>({name:`F3-shadow-${name}`,text:`${prelude}; function make(){${select}}; export default {plugins:[make()]}`,side:'export const flag=true'})),
  { name:'F3-shadow-import-equals', text:`import undefined = require('./side'); function make(){${select}}; export default {plugins:[make()]}`,side:'export const flag=true' },
  { name:'F3-shadow-local-pattern', text:`function make(){const {flag:undefined}={flag:true}; ${select}}; export default {plugins:[make()]}` },
  { name:'F3-shadow-catch', text:`function make(){try {throw true} catch(undefined){${select}}}; export default {plugins:[make()]}` },
  { name:'F3-shadow-catch-pattern', text:`function make(){try {throw {flag:true}} catch({flag:undefined}){${select}}}; export default {plugins:[make()]}` },
  { name:'F3-shadow-for-of', text:`function make(){for(const undefined of [true]){${select}}}; export default {plugins:[make()]}` },
  { name:'F3-shadow-for-in', text:`function make(){for(const undefined in {flag:true}){${select}}}; export default {plugins:[make()]}` },
]

// Exact 18 review2 inputs, including all seven false-safe cases, plus independent
// declaration/lexical variants. Both removal projections must fail closed.
describe('review wr-1d986040 regressions (R2-F1/R2-F3)', () => {
  it.each([...fixtures, ...extra])('$name', fixture => {
    const root = mkdtempSync(join(tmpdir(), 'reference-fix2-'))
    try {
      writeFileSync(join(root, 'runtime.ts'), fixture.text)
      if (fixture.side !== undefined) writeFileSync(join(root, 'side.ts'), fixture.side)
      const graph = analyze(capture({ root, entry: 'runtime.ts' }))
      expect(removal(graph, { entity:'worker', field:'note' }).safe).toBe(false)
      expect(removal(graph, { entity:'worker' }).safe).toBe(false)
      expect(graph.references.some(ref=>ref.entity==='worker' && ref.field==='note')
        || graph.diagnostics.some(item=>item.domain==='schema' || item.domain==='source')).toBe(true)
    } finally { rmSync(root, {recursive:true, force:true}) }
  })
  it.each([
    `const {undefined:flag}={undefined:true};`,
    `import type * as undefined from './side';`,
    `import {type flag as undefined} from './side';`,
  ])('keeps intrinsic undefined when only keys or type imports use its name: %s', prelude => {
    const root = mkdtempSync(join(tmpdir(), 'reference-fix2-control-'))
    try {
      writeFileSync(join(root, 'runtime.ts'), `${prelude} function make(){${select}}; export default {plugins:[make()]}`)
      writeFileSync(join(root, 'side.ts'), 'export interface flag {}')
      const graph = analyze(capture({root, entry:'runtime.ts'}))
      expect(graph.diagnostics).toEqual([])
      expect(graph.coverage).toEqual({registration:'complete', schema:'complete', contract:'complete'})
      expect(removal(graph, {entity:'worker', field:'note'}).safe).toBe(true)
      expect(removal(graph, {entity:'worker'}).safe).toBe(true)
    } finally { rmSync(root, {recursive:true, force:true}) }
  })
  it('keeps an incomplete lexical scan from certifying intrinsic undefined', () => {
    const root = mkdtempSync(join(tmpdir(), 'reference-fix2-budget-'))
    try {
      writeFileSync(join(root, 'runtime.ts'), `const unused=[${Array(100).fill('0').join(',')}]; function make(){${select}}; export default {plugins:[make()]}`)
      const input = capture({root, entry:'runtime.ts'})
      expect(removal(analyze(input), {entity:'worker'}).safe).toBe(true)
      const graph = analyze(input, {maxNodes:80})
      expect(removal(graph, {entity:'worker', field:'note'}).safe).toBe(false)
      expect(removal(graph, {entity:'worker'}).safe).toBe(false)
      expect(graph.diagnostics.length).toBeGreaterThan(0)
    } finally { rmSync(root, {recursive:true, force:true}) }
  })
})
