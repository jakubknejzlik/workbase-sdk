import { resolve } from 'node:path'
import { checkSources } from '@workbasehq/ui-v3/check'
import { extractManifest } from '@workbasehq/ui-v3/vite'
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dirname, '..')
try {
  await checkSources(root)
  const result = await extractManifest(root)
  console.log(`V3 CI passed: ${result.routes.length} routes; schema/uses/layouts/slots/import boundaries/collisions validated (${result.extractionMs} ms)`)
} catch (error) { console.error(String(error)); process.exitCode = 1 }
