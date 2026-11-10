import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { default: config } = await import(pathToFileURL(resolve('packages/mcp/vitest.config.ts')))
const env = { ...config.test.env }
const teardowns = []
for (const path of config.test.globalSetup ?? []) {
  const { default: setup } = await import(pathToFileURL(path))
  teardowns.push(await setup({ config: { env } }))
}
console.log(JSON.stringify({ directory: env.WORKBASE_MCP_STATE_ROOT }))
if (process.env.WORKBASE_TMP_PROBE_WAIT === '1') setInterval(() => {}, 1000)
else for (const teardown of teardowns.reverse()) await teardown?.()
