import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { defineInstance } from '../src/config'
import { plan } from '../src/migrations/planner'
import { createEntity, initialSchema } from '../src/migrations/schema'
import { migrateD1, type D1Query } from '../src/infra/d1-migrations'

beforeEach(reset)

const baseline = defineInstance({ id: 'nullable_ref', revision: 1, roles: ['owner'], permissions: {}, entities: {
  accounts: { fields: { name: { type: 'string', required: true } } },
  people: { fields: { name: { type: 'string', required: true }, manager: { type: 'ref', entity: 'people' }, score: { type: 'int', min: 0, default: 0 } } },
  notes: { fields: { title: { type: 'string' }, person: { type: 'ref', entity: 'people', required: true } } },
} })
function withRef(required = false) {
  return defineInstance({ ...baseline, revision: 2, entities: { ...baseline.entities,
    people: { ...baseline.entities.people,
      fields: { ...baseline.entities.people.fields, user: { type: 'ref', entity: 'accounts', required } },
      relations: { user_account: { field: 'user', entity: 'accounts' } },
    },
  } })
}

it('plans a nullable ref and relation on an existing entity without blocking', () => {
  const migration = plan(baseline, withRef())
  expect(migration.blocked).toEqual([])
  expect(migration.destructive).toEqual([])
  expect(migration.sql).toContain('FOREIGN KEY (organization_id, "user") REFERENCES "accounts"(organization_id, id)')
  expect(migration.sql).toContain('CREATE INDEX "people_user_idx" ON "people"(organization_id, "user")')
})

it('keeps a required ref on an existing entity blocked with a backfill reason', () => {
  const migration = plan(baseline, withRef(true))
  expect(migration.blocked).toEqual([expect.stringMatching(/Required.*reference.*backfill.*people\.user/)])
  expect(migration.sql).not.toContain('CREATE TABLE')
})

// These fixtures contain no semicolons in literals or trigger bodies.
async function apply(db: D1Database, sql: string) {
  const statements = sql.split('\n').filter(line => !line.startsWith('--')).join('\n').split(';').filter(sql => sql.trim())
  return db.batch<Record<string, unknown>>(statements.map(sql => db.prepare(sql)))
}
async function seed(db: D1Database) {
  await apply(db, `
    INSERT INTO organizations VALUES ('org-a','A'),('org-b','B');
    INSERT INTO accounts (id,organization_id,name,created_at,updated_at) VALUES ('a','org-a','A','now','now'),('b','org-b','B','now','now');
    INSERT INTO people (id,organization_id,name,manager,score,created_at,updated_at,version) VALUES ('p1','org-a','One',NULL,7,'created','updated',4),('p2','org-a','Two','p1',3,'created','updated',2),('p3','org-b','Three',NULL,0,'created','updated',1);
    INSERT INTO notes (id,organization_id,title,person,created_at,updated_at) VALUES ('n1','org-a','Keep child','p1','now','now');
  `)
}
const people = (db: D1Database) => db.prepare('SELECT * FROM people ORDER BY id').all().then(result => result.results)

async function expectRebuildClean() {
  expect((await env.DB.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'workbase_rebuild_*'").all()).results).toEqual([])
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  expect(await env.DB.prepare('PRAGMA defer_foreign_keys').first('defer_foreign_keys')).toBe(0)
}

it('accepts real planner CREATE then ADD COLUMN history before a nullable ref rebuild', async () => {
  await apply(env.DB, plan(null, baseline).sql); await seed(env.DB)
  const evolved = defineInstance({ ...baseline, revision: 2, entities: { ...baseline.entities,
    people: { ...baseline.entities.people, fields: { ...baseline.entities.people.fields,
      note: { type: 'string', default: "Keep, (a 'quoted' value)" },
    } },
  } })
  const addition = plan(baseline, evolved)
  expect(addition.blocked).toEqual([])
  expect(addition.sql).toContain('ALTER TABLE "people" ADD COLUMN "note"')
  await apply(env.DB, addition.sql)
  await env.DB.prepare("UPDATE people SET note='Existing note' WHERE id='p1'").run()
  const before = await people(env.DB)
  const target = defineInstance({ ...withRef(), revision: 3, entities: { ...evolved.entities,
    people: { ...evolved.entities.people, fields: { ...evolved.entities.people.fields, user: withRef().entities.people.fields.user } },
  } })
  const migration = plan(evolved, target)
  expect(migration.blocked).toEqual([])
  await apply(env.DB, migration.sql)
  expect(await people(env.DB)).toEqual(before.map(row => ({ ...row, user: null })))
  await expectRebuildClean()
})

it('accepts real planner rename history with reordered config fields before a nullable ref rebuild', async () => {
  const created = defineInstance({ ...withRef(), revision: 1 })
  await apply(env.DB, plan(null, created).sql); await seed(env.DB)
  const evolved = defineInstance({ ...created, revision: 2, entities: { ...created.entities,
    people: { ...created.entities.people, displayField: 'label', fields: {
      score: baseline.entities.people.fields.score,
      label: { ...baseline.entities.people.fields.name, renameFrom: 'name' },
      user: created.entities.people.fields.user,
      manager: baseline.entities.people.fields.manager,
    } },
  } })
  const rename = plan(created, evolved)
  expect(rename.blocked).toEqual([])
  await apply(env.DB, rename.sql)
  const before = await people(env.DB)
  const target = defineInstance({ ...evolved, revision: 3, entities: { ...evolved.entities,
    people: { ...evolved.entities.people, fields: { ...evolved.entities.people.fields, mentor: baseline.entities.people.fields.manager } },
  } })
  const migration = plan(evolved, target)
  expect(migration.blocked).toEqual([])
  await apply(env.DB, migration.sql)
  expect(await people(env.DB)).toEqual(before.map(row => ({ ...row, mentor: null })))
  await expectRebuildClean()
})

it.each([true, false])('keeps deferral on across two rebuilds with existing links=%s, then replays after mutual links', async existingLink => {
  await apply(env.DB, plan(null, baseline).sql); await seed(env.DB)
  // people already references accounts, which is rebuilt second.
  const from = defineInstance({ ...withRef(), entities: {
    people: withRef().entities.people, accounts: baseline.entities.accounts, notes: baseline.entities.notes,
  } })
  await apply(env.DB, plan(baseline, from).sql)
  if (existingLink) await env.DB.prepare("UPDATE people SET user='a' WHERE id='p1'").run()
  const target = defineInstance({ ...from, revision: 3, entities: {
    people: { ...from.entities.people, fields: { ...from.entities.people.fields, mentor: { type: 'ref', entity: 'people' } } },
    accounts: { ...from.entities.accounts, fields: { ...from.entities.accounts.fields, person: { type: 'ref', entity: 'people' } } },
    notes: from.entities.notes,
  } })
  const migration = plan(from, target)
  expect(migration.blocked).toEqual([])
  expect(migration.sql.indexOf('-- Rebuild people')).toBeLessThan(migration.sql.indexOf('-- Rebuild accounts'))
  const before = await people(env.DB)
  await apply(env.DB, migration.sql)
  expect(await people(env.DB)).toEqual(before.map(row => ({ ...row, mentor: null })))
  await expectRebuildClean()
  await apply(env.DB, "UPDATE accounts SET person='p1' WHERE id='a'; UPDATE people SET user='a',mentor='p2' WHERE id='p1';")
  const linkedPeople = await people(env.DB)
  const linkedAccounts = (await env.DB.prepare('SELECT * FROM accounts ORDER BY id').all()).results
  await apply(env.DB, migration.sql)
  expect(await people(env.DB)).toEqual(linkedPeople)
  expect((await env.DB.prepare('SELECT * FROM accounts ORDER BY id').all()).results).toEqual(linkedAccounts)
  expect(await env.DB.prepare('SELECT count(*) n FROM instance_meta WHERE revision=3').first('n')).toBe(1)
  expect(migration.sql.match(/PRAGMA defer_foreign_keys = ON;/g)).toHaveLength(1)
  expect(migration.sql.match(/PRAGMA defer_foreign_keys = OFF;/g)).toHaveLength(1)
  expect(migration.sql.match(/FROM pragma_foreign_key_check/g)).toHaveLength(1)
  expect(migration.sql.indexOf('FROM pragma_foreign_key_check')).toBeGreaterThan(migration.sql.lastIndexOf('-- Rebuild'))
  expect(migration.sql.indexOf('PRAGMA defer_foreign_keys = OFF;')).toBeGreaterThan(migration.sql.indexOf('FROM pragma_foreign_key_check'))
  await expectRebuildClean()
  await expect(env.DB.prepare("UPDATE accounts SET person='missing' WHERE id='a'").run()).rejects.toThrow(/FOREIGN KEY/)
})

it('refuses a later guard before scalar changes and leaves the entire batch unchanged', async () => {
  await apply(env.DB, plan(null, baseline).sql); await seed(env.DB)
  await apply(env.DB, 'CREATE UNIQUE INDEX notes_drift ON notes(title);')
  const target = withRef()
  target.entities.notes.fields.user = { type: 'ref', entity: 'accounts', required: false }
  target.entities.accounts.fields.note = { type: 'string', required: false }
  const migration = plan(baseline, target)
  expect(migration.blocked).toEqual([])
  expect(migration.sql.indexOf('rebuild_requires_review_notes_rowid')).toBeLessThan(migration.sql.indexOf('ALTER TABLE'))
  const schema = (await env.DB.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all()).results
  const before = await people(env.DB)
  await expect(apply(env.DB, migration.sql)).rejects.toThrow(/rebuild_requires_review_notes_indexes/)
  expect((await env.DB.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all()).results).toEqual(schema)
  expect(await people(env.DB)).toEqual(before)
  await expectRebuildClean()
})

it('applies on populated D1, retains rows, matches fresh FK/index behavior and replays without losing links', async () => {
  await apply(env.DB, initialSchema(baseline)); await seed(env.DB)
  await apply(env.FRESH_DB, initialSchema(withRef())); await seed(env.FRESH_DB)
  const before = await people(env.DB)
  const countBefore = await env.DB.prepare('SELECT count(*) n FROM people').first('n')
  const migration = plan(baseline, withRef())
  expect(migration.blocked).toEqual([])
  await apply(env.DB, migration.sql)
  expect(await env.DB.prepare('SELECT count(*) n FROM people').first('n')).toBe(countBefore)
  expect(await people(env.DB)).toEqual(before.map(row => ({ ...row, user: null })))
  expect(await env.DB.prepare('SELECT count(*) n FROM notes').first('n')).toBe(1)
  for (const pragma of ['foreign_key_list', 'index_list', 'table_info']) {
    expect((await env.DB.prepare(`PRAGMA ${pragma}(people)`).all()).results)
      .toEqual((await env.FRESH_DB.prepare(`PRAGMA ${pragma}(people)`).all()).results)
  }
  expect((await env.DB.prepare('PRAGMA index_info(people_user_idx)').all<{ name: string }>()).results.map(row => row.name)).toEqual(['organization_id', 'user'])
  expect(await env.DB.prepare("SELECT \"unique\" FROM pragma_index_list('people') WHERE name='people_user_idx'").first('unique')).toBe(0)

  for (const db of [env.DB, env.FRESH_DB]) {
    const insert = (id: string, user: string | null) => db.prepare("INSERT INTO people (id,organization_id,name,user,created_at,updated_at) VALUES (?,'org-a','New',?,'now','now')").bind(id, user).run()
    await insert('null-link', null)
    await insert('valid-link', 'a')
    await insert('duplicate-link', 'a') // Supplemental ref index is non-unique.
    await expect(insert('missing', 'missing')).rejects.toThrow(/FOREIGN KEY/)
    await expect(insert('cross-org', 'b')).rejects.toThrow(/FOREIGN KEY/)
    await db.prepare("UPDATE people SET user='a' WHERE id='p1'").run()
    await expect(db.prepare("UPDATE people SET user='b' WHERE id='p1'").run()).rejects.toThrow(/FOREIGN KEY/)
    await expect(db.prepare("UPDATE people SET user='missing' WHERE id='p1'").run()).rejects.toThrow(/FOREIGN KEY/)
    await expect(db.prepare("UPDATE people SET organization_id='org-b' WHERE id='valid-link'").run()).rejects.toThrow(/FOREIGN KEY/)
    await expect(db.prepare("UPDATE accounts SET id='changed' WHERE id='a'").run()).rejects.toThrow(/FOREIGN KEY/)
    await expect(db.prepare("DELETE FROM accounts WHERE id='a'").run()).rejects.toThrow(/FOREIGN KEY/)
    await db.prepare("UPDATE people SET user=NULL WHERE id='p1'").run()
    await expect(db.prepare("UPDATE people SET score=-1 WHERE id='p1'").run()).rejects.toThrow(/CHECK/)
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  }
  const linked = await people(env.DB)
  await apply(env.DB, migration.sql)
  expect(await people(env.DB)).toEqual(linked)
  expect(await env.DB.prepare('SELECT count(*) n FROM instance_meta WHERE revision=2').first('n')).toBe(1)
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  await expect(env.DB.prepare("UPDATE people SET user='b' WHERE id='p1'").run()).rejects.toThrow(/FOREIGN KEY/)
})

it('rolls back an interrupted D1 batch and can rerun the migration twice', async () => {
  await apply(env.DB, initialSchema(baseline)); await seed(env.DB)
  const before = await people(env.DB)
  const migration = plan(baseline, withRef())
  expect(migration.blocked).toEqual([])
  await expect(apply(env.DB, migration.sql + '\nINSERT INTO missing_table VALUES (1);')).rejects.toThrow()
  expect(await people(env.DB)).toEqual(before)
  expect(await env.DB.prepare('SELECT max(revision) n FROM instance_meta').first('n')).toBe(1)
  await apply(env.DB, migration.sql)
  await apply(env.DB, migration.sql)
  expect(await people(env.DB)).toEqual(before.map(row => ({ ...row, user: null })))
  expect(await env.DB.prepare('SELECT count(*) n FROM notes').first('n')).toBe(1)
})

it('uses the D1 migration runner transaction and receipt safely after an interrupted upgrade', async () => {
  const initial = initialSchema(baseline), migration = plan(baseline, withRef()).sql
  const files = [
    { filename: '0001_initial.sql', sql: initial, checksum: 'initial-checksum' },
    { filename: '0002_user_link.sql', sql: migration, checksum: 'user-link-checksum' },
  ]
  const query: D1Query = sql => apply(env.DB, sql)
  await migrateD1(query, files.slice(0, 1)); await seed(env.DB)
  const before = await people(env.DB)
  const interrupted: D1Query = sql => query(sql.includes(migration) ? sql + '\nINSERT INTO missing_table VALUES (1);' : sql)
  await expect(migrateD1(interrupted, files)).rejects.toThrow()
  expect(await people(env.DB)).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM _migrations').first('n')).toBe(1)
  expect(await migrateD1(query, files)).toEqual({ applied: 1, total: 2 })
  expect(await people(env.DB)).toEqual(before.map(row => ({ ...row, user: null })))
  const receipts = (await env.DB.prepare('SELECT * FROM _migrations ORDER BY filename').all()).results
  expect(await migrateD1(query, files)).toEqual({ applied: 0, total: 2 })
  expect((await env.DB.prepare('SELECT * FROM _migrations ORDER BY filename').all()).results).toEqual(receipts)
})

it.each(['people_name_idx', 'org_idx'])('preserves declared supplemental indexes through a rebuild: %s', async name => {
  await apply(env.DB, initialSchema(baseline)); await seed(env.DB)
  await apply(env.DB, `CREATE INDEX ${name} ON people(organization_id, name);`)
  const migration = plan(baseline, withRef(), { indexes: [{ entity: 'people', name, fields: ['name'] }] })
  expect(migration.blocked).toEqual([])
  await apply(env.DB, migration.sql)
  expect((await env.DB.prepare(`PRAGMA index_info(${name})`).all<{ name: string }>()).results.map(row => row.name)).toEqual(['organization_id', 'name'])
})

it('checks the previous shape before a combined rename, scalar addition and ref rebuild', async () => {
  await apply(env.DB, initialSchema(baseline)); await seed(env.DB)
  await apply(env.DB, 'CREATE INDEX people_name_idx ON people(organization_id, name);')
  const target = withRef()
  target.entities.people.fields.label = { ...target.entities.people.fields.name, renameFrom: 'name' }
  delete target.entities.people.fields.name
  target.entities.people.displayField = 'label'
  target.entities.people.fields.extra = { type: 'string', required: false, default: 'CREATE INDEX "people_org_idx" ON "people"' }
  const migration = plan(baseline, target, { indexes: [{ entity: 'people', name: 'people_name_idx', fields: ['label'] }] })
  expect(migration.blocked).toEqual([])
  await apply(env.DB, migration.sql)
  expect(await env.DB.prepare("SELECT label,user,extra FROM people WHERE id='p1'").first()).toEqual({ label: 'One', user: null, extra: 'CREATE INDEX "people_org_idx" ON "people"' })
  expect((await env.DB.prepare('PRAGMA index_info(people_name_idx)').all<{ name: string }>()).results.map(row => row.name)).toEqual(['organization_id', 'label'])
})

it('refuses drift before executing combined scalar or rename changes', async () => {
  await apply(env.DB, initialSchema(baseline)); await seed(env.DB)
  await apply(env.DB, 'DROP INDEX people_org_idx; CREATE UNIQUE INDEX people_org_idx ON people(organization_id, name) WHERE score >= 0;')
  const target = withRef()
  target.entities.people.fields.extra = { type: 'string', required: false }
  await expect(apply(env.DB, plan(baseline, target).sql)).rejects.toThrow(/rebuild_requires_review_people_indexes/)
  expect((await env.DB.prepare("SELECT name FROM pragma_table_xinfo('people') WHERE name='extra'").all()).results).toEqual([])
})

it('applies an explicit nullable-ref backfill once and preserves a later cleared link on replay', async () => {
  await apply(env.DB, initialSchema(baseline)); await seed(env.DB)
  await env.DB.prepare("UPDATE people SET name='a' WHERE id='p1'").run()
  const target = withRef()
  target.entities.people.fields.user.backfillFrom = { refField: 'manager', valueField: 'name' }
  const migration = plan(baseline, target)
  expect(migration.blocked).toEqual([])
  await apply(env.DB, migration.sql)
  expect(await env.DB.prepare("SELECT user FROM people WHERE id='p2'").first('user')).toBe('a')
  await env.DB.prepare("UPDATE people SET user=NULL WHERE id='p2'").run()
  await apply(env.DB, migration.sql)
  expect(await env.DB.prepare("SELECT user FROM people WHERE id='p2'").first('user')).toBeNull()
})

it.each([
  'CREATE INDEX untracked_idx ON people(name);',
  'CREATE TRIGGER untracked_trigger AFTER INSERT ON people BEGIN SELECT 1; END;',
  'ALTER TABLE people ADD COLUMN untracked TEXT;',
  'CREATE TABLE cascading_child (person TEXT REFERENCES people(id) ON DELETE CASCADE);',
])('refuses a rebuild with unsupported physical schema before touching data: %s', async extra => {
  await apply(env.DB, initialSchema(baseline)); await seed(env.DB)
  await env.DB.exec(extra.replaceAll('\n', ' '))
  const before = await people(env.DB)
  await expect(apply(env.DB, plan(baseline, withRef()).sql)).rejects.toThrow(/CHECK/)
  expect(await people(env.DB)).toEqual(before)
  expect(await env.DB.prepare('SELECT count(*) n FROM notes').first('n')).toBe(1)
})

it.each([
  ['generated column', 'columns', (sql: string) => sql.replace('"name" TEXT NOT NULL', '"name" TEXT NOT NULL, derived TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL')],
  ['WITHOUT ROWID', 'rowid', (sql: string) => sql.replace(');\nCREATE INDEX "people_org_idx"', ') WITHOUT ROWID;\nCREATE INDEX "people_org_idx"')],
  ['partial UNIQUE index with a known name', 'indexes', (sql: string) => sql.replace('CREATE INDEX "people_org_idx" ON "people"(organization_id, id)', 'CREATE UNIQUE INDEX "people_org_idx" ON "people"(organization_id, name) WHERE score >= 0')],
  ['inline UNIQUE', 'indexes', (sql: string) => sql.replace('"name" TEXT NOT NULL', '"name" TEXT NOT NULL UNIQUE')],
  ['stored generated column', 'columns', (sql: string) => sql.replace('"name" TEXT NOT NULL', '"name" TEXT NOT NULL, derived TEXT GENERATED ALWAYS AS (upper(name)) STORED')],
  ['declared type', 'columns', (sql: string) => sql.replace('"name" TEXT NOT NULL', '"name" BLOB NOT NULL')],
  ['NOT NULL', 'columns', (sql: string) => sql.replace('"name" TEXT NOT NULL', '"name" TEXT')],
  ['default', 'columns', (sql: string) => sql.replace('DEFAULT 0', 'DEFAULT 9')],
  ['primary key', 'columns', (sql: string) => sql.replace('id TEXT PRIMARY KEY', 'id TEXT NOT NULL UNIQUE')],
  ['known index columns', 'indexes', (sql: string) => sql.replace('ON "people"(organization_id, id)', 'ON "people"(organization_id, name)')],
  ['known index uniqueness', 'indexes', (sql: string) => sql.replace('CREATE INDEX "people_org_idx"', 'CREATE UNIQUE INDEX "people_org_idx"')],
  ['known index partial flag', 'indexes', (sql: string) => sql.replace('ON "people"(organization_id, id)', 'ON "people"(organization_id, id) WHERE score > 0')],
  ['known index direction', 'indexes', (sql: string) => sql.replace('ON "people"(organization_id, id)', 'ON "people"(organization_id, id DESC)')],
  ['known index collation', 'indexes', (sql: string) => sql.replace('ON "people"(organization_id, id)', 'ON "people"(organization_id, id COLLATE NOCASE)')],
  ['missing index', 'indexes', (sql: string) => sql.replace('CREATE INDEX "people_org_idx" ON "people"(organization_id, id);', '')],
  ['inline CHECK', 'inline_constraints', (sql: string) => sql.replace('CHECK ("score" >= 0)', 'CHECK ("score" >= -1)')],
  ['hand-added column CHECK', 'inline_constraints', (sql: string) => sql.replace('"name" TEXT NOT NULL', '"name" TEXT NOT NULL CHECK (name NOT IN (\'Blocked, (value)\', \'One Two\'))')],
  ['inline collation', 'inline_constraints', (sql: string) => sql.replace('"name" TEXT NOT NULL', '"name" TEXT NOT NULL COLLATE NOCASE')],
  ['inline conflict clause', 'inline_constraints', (sql: string) => sql.replace('UNIQUE (organization_id, id)', 'UNIQUE (organization_id, id) ON CONFLICT REPLACE')],
  ['foreign key action', 'foreign_keys', (sql: string) => sql.replace('REFERENCES organizations(id)', 'REFERENCES organizations(id) ON UPDATE CASCADE')],
  ['missing foreign key', 'foreign_keys', (sql: string) => sql.replace(',\n  FOREIGN KEY (organization_id, "manager") REFERENCES "people"(organization_id, id)', '')],
  ['extra foreign key', 'foreign_keys', (sql: string) => sql.replace('UNIQUE (organization_id, id)', 'UNIQUE (organization_id, id), FOREIGN KEY (organization_id) REFERENCES organizations(id)')],
  ['foreign key deferrability', 'inline_constraints', (sql: string) => sql.replace('REFERENCES organizations(id)', 'REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED')],
  ['unfamiliar DDL comment', 'inline_constraints', (sql: string) => sql.replace('"name" TEXT NOT NULL', '"name" TEXT /* unknown clause */ NOT NULL')],
] as const)('refuses physical drift: %s', async (_label, difference, modify) => {
  const original = createEntity('people', baseline.entities.people)
  await apply(env.DB, initialSchema(baseline).replace(original, modify(original)))
  await seed(env.DB)
  const before = await people(env.DB)
  const schema = (await env.DB.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='people' ORDER BY type,name").all()).results
  const verifyConstraint = async () => {
    if (_label.includes('UNIQUE')) await expect(env.DB.prepare("UPDATE people SET name='One' WHERE id='p2'").run()).rejects.toThrow(/UNIQUE/)
    if (_label === 'WITHOUT ROWID') await expect(env.DB.prepare("INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES (NULL,'org-a','Null PK','now','now')").run()).rejects.toThrow(/NOT NULL/)
  }
  await verifyConstraint()
  await expect(apply(env.DB, plan(baseline, withRef()).sql)).rejects.toThrow(new RegExp(`rebuild_requires_review.*${difference}`))
  expect(await people(env.DB)).toEqual(before)
  expect((await env.DB.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='people' ORDER BY type,name").all()).results).toEqual(schema)
  expect(await env.DB.prepare('SELECT max(revision) n FROM instance_meta').first('n')).toBe(1)
  await verifyConstraint()
})

it.each(['OneTwo', 'one two'])('does not normalize string contents inside a column CHECK: %s', async changed => {
  const from = defineInstance({ ...baseline, entities: { ...baseline.entities,
    people: { ...baseline.entities.people, fields: { ...baseline.entities.people.fields,
      status: { type: 'enum', values: ['Allowed', 'One Two', "Other, (a 'quoted' value)"], default: 'Allowed' },
    } },
  } })
  await apply(env.DB, plan(null, from).sql.replace("'One Two'", `'${changed}'`)); await seed(env.DB)
  const target = defineInstance({ ...from, revision: 2, entities: { ...from.entities,
    people: { ...from.entities.people, fields: { ...from.entities.people.fields, user: withRef().entities.people.fields.user } },
  } })
  const before = await people(env.DB)
  await expect(apply(env.DB, plan(from, target).sql)).rejects.toThrow(/rebuild_requires_review_people_inline_constraints/)
  expect(await people(env.DB)).toEqual(before)
  await expectRebuildClean()
})

it('blocks a populated users account entity at planning time with a credential-schema reason', async () => {
  const from = defineInstance({ id: 'account_ref', revision: 1, roles: ['owner'], account: { entity: 'users' }, entities: {
    users: { fields: { name: { type: 'string', required: true } } },
    teams: { fields: { name: { type: 'string', required: true } } },
  } })
  await apply(env.DB, initialSchema(from))
  await apply(env.DB, `INSERT INTO organizations VALUES ('org','Org');
    INSERT INTO users (id,organization_id,name,email,password_hash,salt,created_at,updated_at) VALUES ('u','org','User','u@example.test','hash','salt','now','now');`)
  const before = (await env.DB.prepare('SELECT * FROM users').all()).results
  const to = defineInstance({ ...from, revision: 2, entities: { ...from.entities,
    users: { ...from.entities.users, fields: { ...from.entities.users.fields, team: { type: 'ref', entity: 'teams' } } },
  } })
  const migration = plan(from, to)
  expect.soft(migration.blocked).toEqual([expect.stringMatching(/account.*users.*credential/i)])
  if (!migration.blocked.length) await expect(apply(env.DB, migration.sql)).resolves.toBeDefined()
  expect(migration.sql).not.toContain('DROP TABLE')
  expect((await env.DB.prepare('SELECT * FROM users').all()).results).toEqual(before)
})
