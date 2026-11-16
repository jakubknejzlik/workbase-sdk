import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { replayEngine, replayLegacyMigrations } from '../src/offline'

it('runs the existing legacy core repair with rows, indexes, triggers and foreign keys intact', async () => {
  const config = defineInstance({ id: 'legacy_roles', revision: 1, roles: ['owner'], entities: {} })
  const db = new DatabaseSync(':memory:')
  const tables = ['access_tokens', 'invitations', 'memberships']
  try {
    db.exec(initialSchema(config).replaceAll('role TEXT NOT NULL', "role TEXT NOT NULL CHECK(role IN ('owner','dispatcher','viewer'))"))
    db.exec(`
      INSERT INTO organizations VALUES ('org','Organization');
      INSERT INTO users VALUES ('user','user@example.com','hash','salt','created');
      INSERT INTO memberships VALUES ('user','org','owner');
      INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id) VALUES ('invite','org','invite@example.com','viewer','invite-hash','expires','user');
      INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,expires_at,created_at) VALUES ('token','org','user','Token','token-hash','prefix','dispatcher','expires','created');
      CREATE INDEX memberships_custom_idx ON memberships(role,organization_id);
      CREATE TRIGGER memberships_custom_trigger BEFORE INSERT ON memberships WHEN NEW.role = 'blocked' BEGIN SELECT RAISE(ABORT, 'blocked'); END;
    `)
    const rows = () => tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())
    const objects = () => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('access_tokens','invitations','memberships') AND type IN ('index','trigger') ORDER BY type,name").all()
    const fks = () => tables.map(table => db.prepare(`PRAGMA foreign_key_list(${table})`).all())
    const before = { rows: rows(), objects: objects(), fks: fks() }
    expect(() => db.exec("UPDATE memberships SET role='custom'")).toThrow(/CHECK/)
    const batches: string[] = []
    await replayLegacyMigrations(db, replayEngine(config), sql => batches.push(sql))
    expect({ rows: rows(), objects: objects(), fks: fks() }).toEqual(before)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    for (const table of tables) expect(() => db.exec(`UPDATE ${table} SET role='custom'`)).not.toThrow()
    expect(() => db.exec("INSERT INTO memberships VALUES ('missing','org','custom')")).toThrow(/FOREIGN KEY/)
    expect(() => db.exec("INSERT INTO memberships VALUES ('user','org','blocked')")).toThrow(/blocked/)
    expect(db.prepare("SELECT name FROM _plugin_migrations WHERE namespace='workbase-core'").all()).toEqual([{ name: '001_model_b' }])
    const count = batches.length
    await replayLegacyMigrations(db, replayEngine(config), sql => batches.push(sql))
    expect(batches.slice(count).join('\n')).not.toMatch(/DROP TABLE|INSERT INTO _plugin_migrations/)
  } finally { db.close() }
})
