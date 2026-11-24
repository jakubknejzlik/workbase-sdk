import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { widgetDashboard, seedWidgetDashboard } from '../../../core/test/fixtures/widget-dashboard'
import { bootstrap } from '../../../test-support/src/bootstrap'
const [configPath, persist] = process.argv.slice(2)
const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
try {
  await bootstrap(proxy.env.DB, widgetDashboard())
  await seedWidgetDashboard(proxy.env.DB)
} finally { await proxy.dispose() }
