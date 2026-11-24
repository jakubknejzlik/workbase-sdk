import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import fixtures from './reference-review-fix3-fixtures.json'
import { analyze } from '../../src/references/analyze'
import { capture } from '../../src/references/capture'
import { removal } from '../../src/references/model'
import { publicationStep } from '../../src/references/publication'

describe('review3 fail-closed publication, consumers and scope regressions', () => {
  // Exact 16 strict-valid reviewer fixtures + exploratory import-equals; independent
  // probes cover at least three further forms in every review class.
  it.each(fixtures)('$name', fixture => {
    const root = mkdtempSync(join(tmpdir(), 'reference-fix3-'))
    try {
      for (const [name, text] of Object.entries(fixture.files)) writeFileSync(join(root, name), text)
      const graph = analyze(capture({ root, entry:'runtime.ts' }))
      expect(removal(graph, {entity:'worker', field:'note'}).safe).toBe(false)
      expect(removal(graph, {entity:'worker'}).safe).toBe(false)
      expect(graph.references.some(ref => ref.entity === 'worker' && ref.field === 'note')
        || graph.diagnostics.some(item => item.domain === 'schema' || item.domain === 'source')).toBe(true)
    } finally { rmSync(root, {recursive:true, force:true}) }
  })
  it.each([
    ['unused-expression', 'p;'],
    ['unobserved-assignment', 'let alias:typeof p; alias=p;'],
    ['pure-looking-call', 'function identity(value:typeof p){return value}; identity(p);'],
  ])('records the conservative precision boundary: %s', (_name, use) => {
    const root = mkdtempSync(join(tmpdir(), 'reference-fix3-precision-'))
    try {
      writeFileSync(join(root, 'runtime.ts'), `const p={name:'custom',version:'1',schemaReferences:[]}; ${use} export default {plugins:[p]}`)
      const graph = analyze(capture({root, entry:'runtime.ts'}))
      expect(graph.coverage.schema).toBe('unresolved')
      expect(removal(graph, {entity:'worker', field:'note'}).safe).toBe(false)
      expect(removal(graph, {entity:'worker'}).safe).toBe(false)
    } finally { rmSync(root, {recursive:true, force:true}) }
  })
  it('predeclares var over a captured outer environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'reference-fix3-captured-var-'))
    try {
      writeFileSync(join(root, 'runtime.ts'), `function outer(){const flag=true; return ()=>{return flag ? {name:'custom',schemaReferences:[]} : {name:'custom',schemaReferences:[{entity:'worker',field:'note'}]}; if(false){var flag:boolean|undefined=true}}}; export default {plugins:[outer()()]}`)
      const graph = analyze(capture({root, entry:'runtime.ts'}))
      expect(removal(graph, {entity:'worker', field:'note'}).safe).toBe(false)
      expect(removal(graph, {entity:'worker'}).safe).toBe(false)
    } finally { rmSync(root, {recursive:true, force:true}) }
  })
  it('fails closed for an injected unknown publication node kind', () => {
    const identifier = ts.factory.createIdentifier('tracked')
    const known = ts.factory.createParenthesizedExpression(identifier)
    expect(publicationStep(known, identifier)).toBe('next')
    // Model a future parser node containing the same tracked value. The central
    // traversal consumes this exact gap result and invalidates binding stability.
    const future = { ...known, kind: Number.MAX_SAFE_INTEGER } as unknown as ts.Node
    expect(publicationStep(future, identifier)).toBe('gap')
  })
})
