import { createServer } from 'vite'
import { consoleUI } from '@workbasehq/plugins/console/ui/vite'
const plugin = consoleUI()
const server = await createServer({ root: process.cwd(), configFile: false, plugins: [plugin],
  server: { middlewareMode: true, watch: null, ws: false } })
try {
  await plugin.idle()
  if (plugin.error) throw plugin.error
  console.log(JSON.stringify(plugin.generation?.paths))
} finally { await server.close() }
