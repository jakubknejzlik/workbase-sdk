import assert from 'node:assert/strict'
import { writeFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Store } from '../../src/storage'
const root = process.argv[2], dir = join(root, 'examples/probe')
const core = JSON.stringify(resolve('packages/core/src/schema.ts'))
const source = (extra = '') => `import {defineConfig,bindSchemaLock,defineAccess,accessEntities,accessSystemActions} from ${core};
import model,{value} from './schema/model.ts';
export default bindSchemaLock(defineConfig({id:'cache_fixture',displayName:value${extra},interactive:false,languages:['en'],roles:['admin'],organizationOwnerRole:'admin',entities:{record:model},access:defineAccess({predicates:{},entities:Object.fromEntries(accessEntities.map(e=>[e,{admin:'deny'}])),roles:{admin:{system:Object.fromEntries(accessSystemActions.map(a=>[a,'deny']))}}})}),{lockVersion:1,revision:1,parent:null,tables:[]});`
const model = (value: string) => `import {defineEntity} from ${core}; export const value=${JSON.stringify(value)}; export default defineEntity({fields:{name:{type:'string'},${value}:{type:'text'}},access:{admin:'deny'},displayField:'name'});`
await writeFile(join(root, 'package.json'), '{"type":"module"}')
await writeFile(join(dir, 'schema/model.ts'), model('first'))
await writeFile(join(dir, 'config.ts'), source())
await writeFile(join(dir, 'runtime.ts'), "import config from './config.ts'; export default {...config,plugins:[]};")
const store = new Store(root, new Set(['probe'])); await store.init(); await store.load('probe')
await writeFile(join(dir, 'schema/model.ts'), model('second')); await store.load('probe')
await writeFile(join(dir, 'schema/model.ts'), model('third')); await writeFile(join(dir, 'config.ts'), source("+'-changed'"))
const results = []
for (let i = 0; i < 2; i++) { const b = await store.load('probe'); results.push({ fields: Object.keys(b.config.entities.record.fields), runtime: Object.keys(b.runtime!.entities.record.fields), fingerprint: b.fingerprint }) }
await writeFile(join(dir, 'runtime.ts'), "import config from './config.ts'; export default {...config,revision:2,plugins:[]};")
await assert.rejects(() => store.load('probe'), { code: 'revision_mismatch' })
await rm(join(dir, 'runtime.ts')); await symlink(join(dir, 'config.ts'), join(dir, 'runtime.ts'))
await assert.rejects(() => store.load('probe'), { code: 'unsafe_path' })
console.log(JSON.stringify(results))
