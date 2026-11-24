import { provisionLocalSdk } from './local-sdk.ts'
import assert from 'node:assert/strict'
import { writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { Store } from '../../src/storage'
import { Workflow } from '../../src/workflow'
import { bootstrapInstance } from '../../src/bootstrap'
const root = await realpath(process.argv[2]), dir = join(root, 'examples/probe')
const core = "'@workbasehq/core/schema'"
const source = (extra = '') => `import {defineConfig,bindSchemaLock} from ${core};
import model from './schema/record.ts';
import access from './access.ts';
import lock from './schema.lock.json';
export default bindSchemaLock(defineConfig({id:'probe',displayName:'first${extra}',interactive:false,languages:['en'],roles:['admin','staff'],organizationOwnerRole:'admin',entities:{record:model},access}),lock);`
const model = (value: string) => `import {defineEntity} from ${core}; export default defineEntity({fields:{name:{type:'string'},${value}:{type:'text'}},access:{admin:'deny',staff:'deny'},displayField:'name'});`
await writeFile(join(root, 'package.json'), '{"type":"module"}')
await provisionLocalSdk(dir)
await bootstrapInstance(dir, { id: 'probe', target: 'cloudflare-github' })
await writeFile(join(dir, 'access.ts'), `import {defineAccess} from ${core}; export default defineAccess(${JSON.stringify({
  predicates: {}, entities: Object.fromEntries(accessEntities.map(entity => [entity, { admin: 'deny', staff: 'deny' }])),
  roles: Object.fromEntries(['admin', 'staff'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) }])),
})});`)
await writeFile(join(dir, 'schema/record.ts'), model('first'))
await writeFile(join(dir, 'config.ts'), source())
await writeFile(join(dir, 'runtime.ts'), "import config from './config.ts'; export default {...config,plugins:[]};")
const store = new Store(root, new Set(['probe'])); await store.init()
const workflow = new Workflow(store)
const preview = await workflow.call('initialize_instance', { instance: 'probe', mode: 'preview' })
assert.equal(preview.ok, true, JSON.stringify(preview))
const applied = await workflow.call('initialize_instance', { instance: 'probe', mode: 'apply', planHash: preview.planHash })
assert.equal(applied.ok, true, JSON.stringify(applied))
await store.load('probe')
await writeFile(join(dir, 'schema/record.ts'), model('second')); await store.load('probe')
await writeFile(join(dir, 'schema/record.ts'), model('third')); await writeFile(join(dir, 'config.ts'), source('-changed'))
const results = []
for (let i = 0; i < 2; i++) { const b = await store.load('probe'); results.push({ fields: Object.keys(b.config.entities.record.fields), runtime: Object.keys(b.runtime!.entities.record.fields), displayName: b.config.displayName, runtimeDisplayName: b.runtime!.displayName, fingerprint: b.fingerprint }) }
await writeFile(join(dir, 'runtime.ts'), "import config from './config.ts'; export default {...config,revision:2,plugins:[]};")
await assert.rejects(() => store.load('probe'), { code: 'revision_mismatch' })
await rm(join(dir, 'runtime.ts')); await symlink(join(dir, 'config.ts'), join(dir, 'runtime.ts'))
await assert.rejects(() => store.load('probe'), { code: 'unsafe_path' })
console.log(JSON.stringify(results))
