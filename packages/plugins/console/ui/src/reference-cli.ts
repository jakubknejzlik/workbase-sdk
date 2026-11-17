import { validateInstanceReferences } from './references'
const result = await validateInstanceReferences(process.argv[2] ?? 'packages/plugins/console/ui/fixture')
if (result.diagnostics.length) console.error(JSON.stringify(result.diagnostics))
process.exitCode = result.ok ? 0 : 1
