import { env } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { defineInstance, type InstanceInput } from '../src/config'
import * as grammar from '../src/config-shorthand'
import * as policies from '../src/policies'
import { renderPredicate } from '../src/kernel/predicate'
import type { Predicate, PredicateRelation } from '../src/kernel/plugin'
import type { Scope } from '../src/types'
import { foldCorpus } from './fold-corpus'

const input: InstanceInput = {
  id: 'fold', revision: 1, roles: ['viewer'],
  entities: { rows: { displayField: 'id', fields: { parent_id: { type: 'ref', entity: 'rows' } }, relations: {
    children: { entity: 'rows', field: 'parent_id', many: true }, parent: { entity: 'rows', field: 'parent_id' },
  } } }, permissions: { viewer: { rows: ['read'] } },
}
const config = defineInstance(input)
const scope: Scope = { actor: { type: 'user', id: 'viewer' }, role: 'viewer', organizationId: 'org', correlationId: 'fold' }

it('F8 rejects none over false as an always-true named scope at relation use', () => {
  expect(() => defineInstance({ ...input, policyScopes: [{ name: 'empty', where: { children: { none: { id: { in: [] } } } } }], policies: { rows: { viewer: 'scope:empty' } } })).toThrow('Empty policy scope (always true): empty')
})
it('F8 some over false folds to none with equivalent rendered SQL decisions', async () => {
  const where = { children: { some: { id: { in: [] } } } }
  const configured = defineInstance({ ...input, policies: { rows: { viewer: { where } } } })
  expect(policies.policyFilter(configured, 'rows', scope)).toEqual({ kind: 'none' })
  const predicate = policies.policyFoldTest.compile(configured, 'rows', where)
  function sql(node: Predicate, alias: string): string {
    return renderPredicate(node, alias, undefined, (relation: PredicateRelation, parent, negated) =>
      `${negated ? 'NOT ' : ''}EXISTS (SELECT 1 FROM fold_rows child WHERE child.${relation.field} = ${parent}.${relation.parentField} AND ${sql(relation.predicate, 'child')})`).sql
  }
  await env.DB.exec('CREATE TABLE fold_rows (id TEXT, parent_id TEXT); INSERT INTO fold_rows VALUES (\'parent\', NULL), (\'child\', \'parent\'), (\'orphan\', NULL)')
  const before = await env.DB.prepare(`SELECT id FROM fold_rows root WHERE ${sql(predicate, 'root')}`).all()
  const after = await env.DB.prepare('SELECT id FROM fold_rows WHERE 0=1').all()
  expect(before.results).toEqual(after.results)
  expect(after.results).toEqual([])
})
it('F9 609 seeded filters match the real compiled predicate fold (depth <= 4)', () => {
  const corpus = foldCorpus()
  expect(corpus).toHaveLength(609)
  for (const filter of corpus) {
    const predicate = policies.policyFoldTest.compile(config, 'rows', filter)
    expect(grammar.constantFilter(filter, config.entities.rows.relations, config.entities), JSON.stringify(filter)).toBe(policies.policyFoldTest.constantPredicate(predicate))
  }
})
it.each([
  [{ children: { none: { id: { in: [] } } } }, true],
  [{ children: { some: { id: { in: [] } } } }, false],
  [{ parent: { id: { in: [] } } }, false],
  [{ parent: {} }, undefined], [{ children: { some: {} } }, undefined], [{ children: { none: {} } }, undefined],
] as const)('F8 quantifier constant rule %#', (filter, expected) => {
  expect(grammar.constantFilter(filter, config.entities.rows.relations, config.entities)).toBe(expected)
  expect(policies.policyFoldTest.constantPredicate(policies.policyFoldTest.compile(config, 'rows', filter))).toBe(expected)
})
