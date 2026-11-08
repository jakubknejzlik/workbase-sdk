import { mkdir, rm, writeFile } from 'node:fs/promises'
import { plan } from '@workbasehq/core/migrations/planner'
import config from '../config'
const result = plan(null, config)
console.log(JSON.stringify({ blocked: result.blocked, warnings: result.warnings, bytes: result.sql.length }))
if (result.blocked.length) throw new Error('Migration blocked')
await mkdir('migrations', { recursive: true })
await writeFile('migrations/0001_initial.sql', result.sql, { flag: 'wx' })
await rm('migrations/.gitkeep', { force: true })
