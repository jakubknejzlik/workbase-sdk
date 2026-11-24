/** Offline S1 witness. Invoke with an explicit evidence directory; never used by product flows. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { templatePluginSnapshot } from './reference-template-fixture'
import { sdkPackages } from '../../src/references/capture'
import { analyze } from '../../src/references/analyze'
import { shippedSummaries } from '../../src/references/summaries'
import { hash, snapshot, removal } from '../../src/references/model'
import type { WorkbasePlugin } from '../../src/kernel/plugin'
import { resolvePlugins } from '../../src/kernel/composition'

const output = process.argv[2]
if (!output) throw Error('Explicit evidence directory required')
mkdirSync(output, {recursive:true})
const root=process.cwd(), base=execFileSync('git',['merge-base','HEAD','origin/integration/preview'],{encoding:'utf8'}).trim()
const candidate=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
const input=templatePluginSnapshot(root), graph=analyze(input,{summaries:shippedSummaries})
const bytes = Object.fromEntries(Object.keys({...input.sources,...input.dependencies}).sort().map(file=>[file,hash(readFileSync(resolve(root,file)))]))
const original=readFileSync(resolve(root,input.entry),'utf8'), packages=sdkPackages(root)
// Same template registration array, isolated from config/policies/code, with local SDK bindings.
const fixture=original.replace("import config from './config'",'const config = {}').replace(/from '(@workbasehq\/plugins\/[^']+)'/g,(_all,specifier)=>`from ${JSON.stringify(resolve(root,packages[specifier]))}`)
const fixturePath=resolve(output,'offline-template-runtime.ts')
writeFileSync(fixturePath,fixture)
const runtime=(await import(pathToFileURL(fixturePath).href)).default as {plugins: WorkbasePlugin[]}
resolvePlugins(runtime.plugins,true) // current composition validator; no hooks executed
const runtimeMetadata=runtime.plugins.map(plugin=>({name:plugin.name, schemaReferences:plugin.schemaReferences??[], provides:plugin.provides??{}, requires:plugin.requires??{}, optionalRequires:plugin.optionalRequires??{}}))
const staticMetadata=graph.registrations.map(registration=>{
  const leaf=shippedSummaries.find(summary=>summary.symbol===registration.summary?.symbol && summary.file===registration.summary.file)
  assert(leaf,'Every registration needs a verified leaf')
  const records=(kind:'provides'|'requires'|'optionalRequires')=>Object.fromEntries(graph.contracts.filter(contract=>contract.registration===registration.id && contract.kind===kind).map(contract=>[contract.name,contract.range]))
  return {name:registration.name,schemaReferences:graph.references.filter(ref=>ref.registration===registration.id).map(({entity,field})=>({entity,...(field!==undefined?{field}:{})})),provides:records('provides'),requires:records('requires'),optionalRequires:records('optionalRequires')}
})
assert.equal(runtimeMetadata.length,9)
assert.deepEqual(staticMetadata,runtimeMetadata)
assert.deepEqual(graph.diagnostics,[])
assert.deepEqual(graph.coverage,{registration:'complete',schema:'complete',contract:'complete'})
const referenced=snapshot({...input,sources:{...input.sources,[input.entry]:original.replace('createIdentity(),',`{...createIdentity(), schemaReferences:[{entity:'worker',field:'note'}]},`)}})
const unsafeGraph=analyze(referenced,{summaries:shippedSummaries})
const controls={safeField:removal(graph,{entity:'worker',field:'note'}),safeEntity:removal(graph,{entity:'unrelated'}),unsafeField:removal(unsafeGraph,{entity:'worker',field:'note'}),unsafeEntity:removal(unsafeGraph,{entity:'worker'})}
assert(controls.safeField.safe && controls.safeEntity.safe && !controls.unsafeField.safe && !controls.unsafeEntity.safe)
const simplify=(value:typeof graph)=>({...value,snapshot:{entry:value.snapshot.entry,fingerprint:value.snapshot.fingerprint,sourceHash:value.snapshot.sourceHash,resolutionHash:value.snapshot.resolutionHash,dependencyHash:value.snapshot.dependencyHash,failures:value.snapshot.failures,sourceHashes:Object.fromEntries(Object.entries(value.snapshot.sources).map(([file,text])=>[file,hash(text)])),dependencyHashes:Object.fromEntries(Object.entries(value.snapshot.dependencies).map(([file,text])=>[file,hash(text)])),resolutions:value.snapshot.resolutions}})
const after=Object.fromEntries(Object.keys(bytes).map(file=>[file,hash(readFileSync(resolve(root,file)))]))
assert.deepEqual(after,bytes)
const implementationFiles=execFileSync('git',['ls-files','packages/core/src/references'],{encoding:'utf8'}).trim().split('\n').filter(Boolean)
const implementationHashes=Object.fromEntries(implementationFiles.map(file=>[file,hash(readFileSync(file))]))
const historicalSites=[
  ['identity','createIdentity',4904,4915],['permissions','permissions',881,901],
  ['permissions','permissions',928,1055],['permissions','permissions',932,1054],
  ['members','createMembers',2919,2929],['organizations','createOrganizations',2175,2191],
  ['local-auth','createLocalAuth',2877,2889],
].map(([folder,symbol,start,end])=>{
  const file=`packages/plugins/${folder}/src/index.ts`, text=input.sources[file], a=Number(start), b=Number(end)
  const leaf=shippedSummaries.find(item=>item.file===file&&item.symbol===symbol)
  assert(leaf && hash(text)===leaf.sourceHash)
  const excerpt=text.slice(a,b)
  assert(excerpt.startsWith('...')||excerpt.startsWith('defaults ==='))
  const line=text.slice(0,a).split('\n').length, column=a-(text.lastIndexOf('\n',a-1)+1)+1
  return {file,start:a,end:b,line,column,excerpt,coveredBy:String(symbol),schemaCoverage:'complete',artificialGaps:0}
})
const report={base,candidate,implementationHashes,analyzerVersion:graph.analyzerVersion,summaryVersion:graph.summaryVersion,sourceHash:input.sourceHash,resolutionHash:input.resolutionHash,dependencyHash:input.dependencyHash,summaryDependencyHash:shippedSummaries[0].dependencyHash,
 scope:'isolated plugin inventory; config/policies/code collectors belong to S2',
 fixture:{template:input.entry,templateHash:hash(original),offlineRuntimeHash:hash(fixture),changes:'Replace config import with {}; bind nine imports to exact selected local SDK sources. Static config is an explicit empty module; template scaffolding/config artifacts are outside this isolated plugin inventory.'},
 comparison:{equal:true,registrations:9,historicalCompositionSites:historicalSites,artificialGaps:0,runtimeMetadata,staticMetadata},controls,unchangedInputs:{equal:true,before:bytes,after}}
writeFileSync(resolve(output,'runtime-artifact.json'),JSON.stringify(report,null,2)+'\n')
writeFileSync(resolve(output,'coverage.json'),JSON.stringify(simplify(graph),null,2)+'\n')
writeFileSync(resolve(output,'referenced-coverage.json'),JSON.stringify(simplify(unsafeGraph),null,2)+'\n')
console.log(JSON.stringify({candidate,base,comparison:report.comparison.equal,registrations:9,coverage:graph.coverage,controls:Object.fromEntries(Object.entries(controls).map(([name,value])=>[name,value.safe])),unchangedInputs:true}))
