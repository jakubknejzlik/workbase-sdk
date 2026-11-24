/** Internal build-time API. Deliberately absent from package exports/runtime index. */
import { createHash } from 'node:crypto'

export const ANALYZER_VERSION = 'snapshot-1'
export const SUMMARY_VERSION = 'sdk-leaves-1'
export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export interface Span {
  readonly file: string; readonly start: number; readonly end: number
  readonly line: number; readonly column: number; readonly endLine: number; readonly endColumn: number
}
export type Domain = 'registration' | 'schema' | 'contract' | 'source'
export interface Diagnostic {
  readonly domain: Domain; readonly code: string; readonly message: string; readonly span: Span
  readonly repair: string; readonly uses: readonly Span[]
}
export interface Reference {
  readonly entity: string; readonly field?: string; readonly span: Span; readonly uses: readonly Span[]
  readonly certainty: 'definite' | 'possible'; readonly registration: string
}
export interface Contract {
  readonly kind: 'provides' | 'requires' | 'optionalRequires'; readonly name: string; readonly range: string
  readonly span: Span; readonly uses: readonly Span[]; readonly registration: string
}
export interface Resolution { readonly from: string; readonly specifier: string; readonly target?: string; readonly identity: string }
export interface Snapshot {
  readonly entry: string; readonly sources: Readonly<Record<string, string>>
  readonly resolutions: readonly Resolution[]; readonly dependencies: Readonly<Record<string, string>>
  readonly failures: readonly { file: string; message: string }[]
  readonly sourceHash: string; readonly resolutionHash: string; readonly dependencyHash: string; readonly fingerprint: string
}
export function digestRecord(record: Readonly<Record<string, string>>): string {
  return hash(JSON.stringify(Object.keys(record).sort().map(key => [key, hash(record[key])])))
}
export function snapshot(input: Pick<Snapshot, 'entry' | 'sources'> & Partial<Pick<Snapshot, 'resolutions' | 'dependencies' | 'failures'>>): Snapshot {
  const sources = { ...input.sources }, dependencies = { ...input.dependencies }
  const resolutions = (input.resolutions ?? []).map(item => ({ ...item })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))
  const failures=(input.failures ?? []).map(item=>({...item}))
  for(const file of Object.keys(sources)) if(Object.hasOwn(dependencies,file) && dependencies[file]!==sources[file])
    failures.push({file,message:'Inconsistent captured source/dependency bytes'})
  const seen=new Set<string>()
  for(const edge of resolutions) {
    const key=JSON.stringify([edge.from,edge.specifier])
    if(seen.has(key)) failures.push({file:edge.from,message:'Duplicate or ambiguous captured resolution'})
    seen.add(key)
  }
  const sourceHash=digestRecord(sources), resolutionHash=hash(JSON.stringify(resolutions)), dependencyHash=digestRecord(dependencies)
  return freeze({entry:input.entry,sources,dependencies,resolutions,failures,sourceHash,resolutionHash,dependencyHash,
    fingerprint:hash(JSON.stringify([input.entry,sourceHash,resolutionHash,dependencyHash,failures]))})
}
export interface LeafSummary {
  readonly version: string; readonly file: string; readonly symbol: string; readonly sourceHash: string
  /** Complete reviewed dependency closure, including package manifests and dependency lock. */
  readonly dependencies: Readonly<Record<string, string>>
  readonly dependencyHash: string; readonly resolutionHash: string
  readonly arguments: 'configuration-only'
  readonly name: string; readonly schemaReferences: readonly { entity: string; field?: string }[]
  readonly provides: Readonly<Record<string, string>>; readonly requires: Readonly<Record<string, string>>
  readonly optionalRequires: Readonly<Record<string, string>>
  readonly evidence: string
}
export interface Coverage {
  readonly registration: 'complete' | 'unresolved' | 'invalid'
  readonly schema: 'complete' | 'unresolved' | 'invalid'
  readonly contract: 'complete' | 'unresolved' | 'invalid'
}
export interface Registration {
  readonly id: string; readonly name?: string; readonly span: Span; readonly uses: readonly Span[]; readonly definitions: readonly Span[]; readonly coverage: Coverage
  readonly summary?: { version: string; file: string; symbol: string; dependencyHash: string }
}
export interface Graph {
  readonly analyzerVersion: string; readonly summaryVersion: string; readonly snapshot: Snapshot
  readonly limits: {readonly maxNodes:number;readonly maxModules:number;readonly maxDepth:number;readonly maxBranches:number}
  readonly summaryHash: string; readonly analysisHash: string
  readonly registrations: readonly Registration[]; readonly references: readonly Reference[]
  readonly contracts: readonly Contract[]; readonly diagnostics: readonly Diagnostic[]; readonly coverage: Coverage
}
/** An isolated inventory can be used today; later collectors must add their own gaps/failures. */
export function removal(graph: Graph, target: { entity: string; field?: string }) {
  const references = graph.references.filter(ref => ref.entity === target.entity && (target.field === undefined || ref.field === target.field))
  const diagnostics = graph.diagnostics.filter(item => item.domain !== 'contract' || item.code.startsWith('invalid'))
  return freeze({ target: { ...target }, safe: references.length === 0 && diagnostics.length === 0
    && graph.coverage.registration === 'complete' && graph.coverage.schema === 'complete', references, diagnostics, coverage: graph.coverage })
}
