import { validateInstanceReferences } from '@workbasehq/plugins/console/ui/check'
const result = await validateInstanceReferences(process.cwd())
if (result.diagnostics.length) console.error(JSON.stringify(result.diagnostics))
process.exitCode = result.ok ? 0 : 1
