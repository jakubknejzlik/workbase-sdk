import { createRequire } from 'node:module'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FullResult, Reporter } from '@playwright/test/reporter'

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

/** Check all retained run files, including Wrangler's generated files and logs. */
export function assertNoSecrets(directory: string, secrets: string[]) {
  const leaked = files(directory).filter(path => {
    const bytes = readFileSync(path)
    return secrets.some(secret => bytes.includes(secret))
  })
  if (leaked.length) throw new Error(`Fixture secret retained in: ${leaked.join(', ')}`)
}

export function redactAuthorization(text: string): string {
  // Handles JSON headers, API call logs, and plain request logging. Keep the
  // scheme so traces still explain which authentication path was exercised.
  return text.replace(/\bBearer\s+[^\s"'`\\<>,;}]+/gi, 'Bearer [REDACTED]')
}

async function redactTrace(path: string) {
  // Reuse the ZIP implementation shipped with the pinned Playwright dependency.
  const require = createRequire(createRequire(import.meta.url).resolve('playwright/package.json'))
  const { yauzl, yazl } = require('playwright-core/lib/zipBundle')
  const entries: { name: string; bytes: Buffer }[] = []
  await new Promise<void>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error: Error | null, zip: any) => {
      if (error) return reject(error)
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry: { fileName: string }) => {
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return }
        zip.openReadStream(entry, (error: Error | null, stream: NodeJS.ReadableStream) => {
          if (error) return reject(error)
          const chunks: Buffer[] = []
          stream.on('error', reject)
          stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
          stream.on('end', () => {
            const bytes = Buffer.concat(chunks)
            // Trace/network JSON lines and source/attachment text may all carry
            // request logging. Preserve binary screenshots and other resources.
            const text = bytes.toString('utf8')
            entries.push({ name: entry.fileName, bytes: Buffer.from(text).equals(bytes) ? Buffer.from(redactAuthorization(text)) : bytes })
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
  const zip = new yazl.ZipFile()
  const chunks: Buffer[] = []
  const output = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.on('error', reject)
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
  for (const entry of entries) zip.addBuffer(entry.bytes, entry.name)
  zip.end()
  writeFileSync(path, await output)
}

/** Runs after worker teardown, when Playwright has finished writing trace ZIPs. */
export default class WorkflowArtifactReporter implements Reporter {
  async onEnd(_result: FullResult) {
    const { artifactRoot } = await import('./workflow-setup')
    for (const path of files(artifactRoot)) {
      if (path.endsWith('.zip')) await redactTrace(path)
      else if (/\.(json|log|trace|network)$/.test(path)) {
        const text = readFileSync(path, 'utf8')
        const redacted = redactAuthorization(text)
        if (text !== redacted) writeFileSync(path, redacted)
      }
    }
  }
}
