import { capture, sdkDependencyFiles, sdkPackages } from '../../src/references/capture'
import { snapshot } from '../../src/references/model'

/** Exact template registration bytes with an explicit empty config for an isolated plugin inventory.
 * The real template config contains scaffolding placeholders and missing generated lock/OpenAPI
 * artifacts. It is not an executable instance. S2 must collect config, policies and code separately.
 */
export function templatePluginSnapshot(root = process.cwd()) {
  const captured = capture({root,entry:'packages/mcp/templates/standalone/runtime.ts',packages:sdkPackages(root),dependencies:sdkDependencyFiles(root)})
  const prefix='packages/mcp/templates/standalone/', config=prefix+'config.ts'
  const included=(file:string)=>!file.startsWith(prefix)||file===captured.entry||file===config
  return snapshot({...captured,
    sources:{...Object.fromEntries(Object.entries(captured.sources).filter(([file])=>included(file))),[config]:'export default {}'},
    resolutions:captured.resolutions.filter(edge=>included(edge.from)&&edge.from!==config),
  })
}
