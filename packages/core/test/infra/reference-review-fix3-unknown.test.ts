import { describe, expect, it, vi } from 'vitest'
import { analyze } from '../../src/references/analyze'
import { snapshot, removal } from '../../src/references/model'

vi.mock('typescript', async importOriginal => {
  const original = await importOriginal<{default: typeof import('typescript')}>()
  const ts = original.default
  return { default: { ...ts, createSourceFile: (...args: Parameters<typeof ts.createSourceFile>) => {
    const file = ts.createSourceFile(...args)
    if (args[1].includes('/*inject-unknown*/')) {
      const inject = (node: import('typescript').Node): void => {
        if (ts.isParenthesizedExpression(node)) {
          // Future syntax may be opaque to forEachChild. Hide a real tracked use
          // inside it, rather than calling the classifier with a synthetic leaf.
          ;(node as unknown as {kind:number}).kind = args[1].includes('/*unknown-token*/') ? ts.SyntaxKind.Unknown : Number.MAX_SAFE_INTEGER
        } else ts.forEachChild(node, inject)
      }
      inject(file)
    }
    return file
  } } }
})

describe('unknown parser node fail-closed default', () => {
  it.each(['future-kind', 'unknown-token'])('emits a relevant gap when %s hides the tracked identifier', marker => {
    const text = `const p={name:'custom',version:'1',schemaReferences:[]}; const alias=(p); export default {plugins:[p]}`
    const plain = analyze(snapshot({entry:'runtime.ts', sources:{'runtime.ts':text}}))
    expect(plain.diagnostics).toEqual([])
    expect(removal(plain, {entity:'worker'}).safe).toBe(true)
    const graph = analyze(snapshot({entry:'runtime.ts', sources:{'runtime.ts':'/*inject-unknown*//*'+marker+'*/'+text}}))
    expect(graph.coverage.schema).toBe('unresolved')
    expect(graph.diagnostics.some(item => item.domain === 'schema')).toBe(true)
    expect(removal(graph, {entity:'worker', field:'note'}).safe).toBe(false)
    expect(removal(graph, {entity:'worker'}).safe).toBe(false)
  })
})
