import { env } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'
import sample from './fixtures/sample/config'
import { KernelRegistry, renderPredicate } from '../src/kernel/registry'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { tenancy } from '../src/kernel/adapters/tenancy'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { compileRoot } from '../src/query/compiler'
import { validateQuery, type Scalar } from '../src/query/schema'
import { scopeOperations } from '../src/scope-operations'
import type { Scope } from '../src/types'

// C7B-06: use Workers D1, whose bound REAL-to-TEXT conversion exposed the regression.
const cases: [string, Scalar[]][] = [
  ['empty', []], ['integer', [1]], ['string integer', ['1']],
  ['fractional', [1.5]], ['string fractional', ['1.5']], ['leading zero', ['01']],
  ['string exponent', ['1e2']], ['integer 100', [100]], ['true', [true]],
  ['false', [false]], ['null', [null]], ['integer or null', [1, null]],
  ['mixed', ['1', 0, false, null]], ['negative zero', [-0]], ['zero', [0]],
  ['negative integer', [-1]], ['exponent', [1e21]], ['hostile', ["hostile?1'"]],
  ['100 items', Array.from({ length: 100 }, (_, i) => i)],
  ['string large exponent', ['1.0e+21']], ['string 123', ['123']],
  ['plain string', ['plain']], ['text id', ['007']],
]
const config = { ...sample, entities: { ...sample.entities, clients: {
  ...sample.entities.clients, fields: { ...sample.entities.clients.fields,
    i: { type: 'int' as const }, r: { type: 'float' as const },
  },
} } }
const scope: Scope = { organizationId: 'org-a', role: 'owner', actor: { type: 'user', id: 'owner-a' }, correlationId: 'membership-affinity' }
scopeOperations.set(scope, { operations: null })
const kernel = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac] })

beforeAll(async () => {
  await env.DB.exec("CREATE TABLE clients (id TEXT, organization_id TEXT, i INTEGER, r REAL, name TEXT, created_at TEXT, updated_at TEXT, version INTEGER, email TEXT); INSERT INTO clients(id,organization_id,i,r,name) VALUES ('01','org-a',1,1.0,'1'),('02','org-a',0,0.0,'0'),('03','org-a',1.5,1.5,'1.5'),('04','org-a',100,100.0,'1e2'),('05','org-a',NULL,NULL,NULL),('06','org-a',-1,-1.0,'-1'),('07','org-a',1e21,1e21,'1.0e+21'),('08','org-a',123,123,'123'),('09','org-a',7,7,'007'),('10','org-a',NULL,NULL,'plain'),('11','org-a',NULL,NULL,'hostile?1''')")
})

for (const [affinity, column] of [['INTEGER', 'i'], ['REAL', 'r'], ['TEXT', 'name']]) {
  for (const [label, values] of cases) it(`D1 membership affinity ${affinity}: ${label}`, async () => {
    const operands = values.filter(v => v !== null).map(v => typeof v === 'boolean' ? Number(v) : v)
    const nullArm = values.includes(null) ? ` OR ${column} IS NULL` : ''
    const oldSql = `SELECT id FROM clients WHERE (${operands.length ? `${column} IN (${operands.map(() => '?').join(',')})` : '0=1'}${nullArm}) ORDER BY id`
    const old = await (operands.length ? env.DB.prepare(oldSql).bind(...operands) : env.DB.prepare(oldSql)).all()
    const predicate = { [column]: { in: values } }
    const rendered = renderPredicate(predicate, 'clients')
    // Internal compiler AST deliberately permits the same typed operands as trusted plugins.
    const compiled = compileRoot(kernel, scope, { entity: 'clients', select: ['id'], limit: 100, where: predicate })
    const pluginKernel = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, {
      name: 'affinity_filter', version: '1', tableFilter: entity => entity === 'clients'
        ? { kind: 'where', predicate } : { kind: 'all' },
    }] })
    const { query, cost } = validateQuery(pluginKernel, scope, { entity: 'clients', select: ['id'], limit: 100 })
    const plugin = compileRoot(pluginKernel, scope, query, undefined, cost)
    for (const [path, statement] of [
      ['compiler', compiled], ['predicate', { sql: `SELECT id FROM clients WHERE ${rendered.sql} ORDER BY id`, bindings: rendered.bindings }], ['tableFilter', plugin],
    ] as const) {
      const actual = await env.DB.prepare(statement.sql).bind(...statement.bindings).all()
      expect(actual.results, path).toEqual(old.results)
      expect(statement.bindings.filter(v => v === JSON.stringify(operands)), `${path}: one JSON binding`).toHaveLength(operands.length ? 1 : 0)
    }
  })
}
