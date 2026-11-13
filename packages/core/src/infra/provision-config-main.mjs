// Executed only in a fresh Node process. Never import this entry into SST's bundle.
import { pathToFileURL } from 'node:url'

const finish = result => process.send(result, () => process.exit(0))
const [configPath, migrationsDirectory] = process.argv.slice(2)
async function main() {
  let config
  try {
    const { tsImport } = await import('tsx/esm/api')
    config = (await tsImport(pathToFileURL(configPath).href, import.meta.url)).default
  } catch (error) {
    return finish({ kind: 'load-error', message: error instanceof Error ? error.message : String(error) })
  }
  if (!config || typeof config.id !== 'string' || !Number.isInteger(config.revision) || config.revision < 1 || !config.entities) {
    finish({ kind: 'invalid-config' })
  } else {
    try {
      // Keep plugin functions and schemas in this process. Era is config data
      // shared across both tsImport realms; only fingerprints cross IPC.
      const { tsImport } = await import('tsx/esm/api')
      const { expectedSchema } = await tsImport(new URL('./schema.ts', import.meta.url).href, import.meta.url)
      const schema = await expectedSchema({ migrationsDirectory, revision: config.revision, config })
      finish({ kind: 'schema', schema })
    } catch {
      finish({ kind: 'schema-error' })
    }
  }
}
await main()
