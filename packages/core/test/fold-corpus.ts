import type { Filter } from '../src/query/schema'

/** Fixed seed, at most four edges, including Boolean and relation nesting. */
export function foldCorpus(): Filter[] {
  let seed = 0x704
  const pick = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n) }
  function generate(depth: number): Filter {
    const choice = pick(depth === 4 ? 4 : 10)
    if (choice === 0) return {}
    if (choice === 1) return { id: { eq: `row-${pick(10000)}` } }
    if (choice === 2) return { id: { in: [] } }
    if (choice === 3) return { id: { in: [`row-${pick(10000)}`, 'other'] } }
    if (choice === 4) return { not: generate(depth + 1) }
    if (choice === 5 || choice === 6) return { [choice === 5 ? 'and' : 'or']: [generate(depth + 1), generate(depth + 1)] }
    if (choice === 7) return { parent: generate(depth + 1) }
    return { children: { [choice === 8 ? 'some' : 'none']: generate(depth + 1) } }
  }
  const fixed: Filter[] = [
    { and: [{}] }, { or: [{}, { id: { eq: 'row' } }] }, { not: { id: { in: [] } } },
    { children: { none: { id: { in: [] } } } }, { children: { some: { id: { in: [] } } } },
    { parent: { id: { in: [] } } }, { parent: {} },
    { children: { some: {} } }, { children: { none: {} } },
  ]
  const corpus = new Map(fixed.map(filter => [JSON.stringify(filter), filter]))
  while (corpus.size < 609) {
    const filter = generate(0)
    corpus.set(JSON.stringify(filter), filter)
  }
  return [...corpus.values()]
}
