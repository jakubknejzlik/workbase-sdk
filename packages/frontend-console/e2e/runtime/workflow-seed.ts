// Both proxies finish and dispose before setup starts wrangler dev.
import './seed'
import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
const [configPath, persist] = process.argv.slice(2)
const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
try {
  const now = new Date().toISOString()
  for (const id of ['c5-terminal', 'c5-unmount']) {
    await proxy.env.DB.prepare(`INSERT INTO workflow_runs
      (id,organization_id,actor_id,actor_type,definition_name,definition_version,input_json,definition_signature,status,correlation_id,next_attempt_at,created_at,updated_at)
      VALUES (?,'org-a','owner','user','synthetic-c5','1','{}','synthetic-only','running',?,0,?,?)`).bind(id, id, now, now).run()
  }
} finally { await proxy.dispose() }
