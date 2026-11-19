import { defineConfig, defineEntity } from '../../src/schema'
import type { UniqueConstraint } from '../../src/entity-constraints'

const immutable = { kind: 'ref_immutable', name: 'client_locked', field: 'client', referencedBy: { entity: 'booking', field: 'location' } } as const
const equality = { kind: 'ref_equality', name: 'client_matches', field: 'client', through: 'site', targetField: 'client' } as const
type LocationUnique = UniqueConstraint & { fields: 'label'[]; where?: { field: 'status' } }
const unique: LocationUnique = { kind: 'unique', name: 'label_unique', fields: ['label'] }
export const uniqueTransitions: [string, LocationUnique[], LocationUnique[]][] = [
  ['add unique', [], [unique]],
  ['remove unique', [unique], []],
  ['change predicate', [{ ...unique, where: { field: 'status', op: 'eq', value: 'inactive' } }], [{ ...unique, where: { field: 'status', op: 'eq', value: 'active' } }]],
]
export function reviewConfig(keys: LocationUnique[] = [], forward = false) {
  const constraints = [immutable, ...keys, ...(forward ? [equality] : [])]
  return defineConfig({ id: 'immutable_review', roles: ['owner'], organizationOwnerRole: 'owner', languages: ['en'], entities: {
    client: defineEntity({ displayField: 'id', fields: {} }),
    site: defineEntity({ displayField: 'id', fields: { client: { type: 'ref', entity: 'client' } } }),
    location: defineEntity({ displayField: 'id', fields: { client: { type: 'ref', entity: 'client' }, site: { type: 'ref', entity: 'site' }, label: { type: 'text' }, status: { type: 'text' } }, constraints }),
    booking: defineEntity({ displayField: 'id', fields: { location: { type: 'ref', entity: 'location' } } }),
  } })
}
export const organizationsSQL = "PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF; CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES('a');"
export const seedSQL = `INSERT INTO client(id,organization_id,created_at,updated_at) VALUES('c1','a','now','now'),('c2','a','now','now');
INSERT INTO site(id,organization_id,created_at,updated_at,client) VALUES('s','a','now','now','c1');
INSERT INTO location(id,organization_id,created_at,updated_at,client,site,label,status) VALUES('used','a','now','now','c1','s','used','active');
INSERT INTO booking(id,organization_id,created_at,updated_at,location) VALUES('held','a','now','now','used');`
// s4-review2: delete the referenced identity through its unique label, then reuse its id.
export const multiReplaceSQL = "INSERT OR REPLACE INTO location(id,organization_id,created_at,updated_at,client,label,status) VALUES('replacement','a','now','now','c2','used','active'),('used','a','now','now','c2','new','active')"
export const forwardReplaceSQL = "INSERT OR REPLACE INTO location(id,organization_id,created_at,updated_at,client,site) VALUES('used','a','now','now','c2','s')"
export const schemaObjectsSQL = "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
export const immutableConflict = { status: 409, code: 'ref_immutable', detail: { constraintId: 'location.client_locked' } }
