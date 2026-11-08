import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// A bundled SST program has a different import.meta.url. Resolve the installed
// export first so config evaluation and migrations use the installed SDK bytes.
// Deployment providers must instead use SST's platform runtime (sst-runtime.ts).
export function installedInfraDirectory(): string {
  return dirname(fileURLToPath(import.meta.resolve('@workbasehq/core/infra')))
}
