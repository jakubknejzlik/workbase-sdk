import { resolve } from 'node:path'
import { getPlatformProxy } from 'wrangler'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import config from '../config'
const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: resolve('wrangler.jsonc'), persist: { path: resolve('.wrangler/state/v3') } })
try { await new KernelRegistry(config).applyMigrations(proxy.env.DB); console.log('Plugin migrations applied') }
finally { await proxy.dispose() }
