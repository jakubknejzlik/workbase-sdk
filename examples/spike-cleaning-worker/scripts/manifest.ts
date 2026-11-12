import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { extractManifest } from '@workbasehq/ui-v3/vite'
const result = await extractManifest(resolve(import.meta.dirname, '..'))
await mkdir('artifacts', { recursive: true })
await writeFile('artifacts/manifest.json', JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
