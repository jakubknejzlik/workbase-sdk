import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defineConfig, bindSchemaLock, defineAccess, accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { schemaLock } from '@workbasehq/core/migrations/schema-lock'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { expectedSnapshot } from '../src/offline'
import { prepare } from '../src/planning'
import { applyDisposable } from '../src/disposable'

const tamper = vi.hoisted(() => ({ sql: '', applied: false }))
// Change only receipt rows after the real Wrangler process has finished. The
// physical schema stays identical, so only verification of persisted rows fails.
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: (...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args)
    child.on('close', code => {
      if (code !== 0 || !tamper.sql) return
      const visit = (root: string): void => {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const path = join(root, entry.name)
          if (entry.isDirectory()) visit(path)
          else if (/^[a-f0-9]{64}\.sqlite$/.test(entry.name)) {
            const db = new DatabaseSync(path)
            try { db.exec(tamper.sql); tamper.applied = true } finally { db.close() }
          }
        }
      }
      visit(join(String(args[2]?.cwd), 'persist'))
    })
    return child
  } }
})
afterEach(() => { tamper.sql = ''; tamper.applied = false })

it.each([
  ['domain checksum', "UPDATE _migrations SET checksum='changed'", 'migration_history_mismatch'],
  ['plugin checksum', "UPDATE _plugin_migrations SET checksum='changed' WHERE namespace='receipt_plugin'", 'migration_plugin_history_mismatch'],
  ['missing plugin receipt', "DELETE FROM _plugin_migrations WHERE namespace='receipt_plugin'", 'migration_instance_verification_failed'],
  ['revision', 'UPDATE instance_meta SET revision=99 WHERE revision=2', 'migration_instance_revision_mismatch'],
])('verifies actual disposable %s independently of physical schema', async (_name, sql, code) => {
  const current = defineConfig({ id: 'receipt_fixture', interactive: false, languages: ['en'], roles: ['owner'], organizationOwnerRole: 'owner', entities: {},
    plugins: [{ name: 'receipt_plugin', version: '1.0.0', migrations: [{ name: '001_plugin', sql: 'CREATE TABLE IF NOT EXISTS plugin_state (value TEXT);' }] }],
    access: defineAccess({ predicates: {}, entities: Object.fromEntries(accessEntities.map(entity => [entity, { owner: 'deny' }])),
      roles: { owner: { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) } } }),
  })
  bindSchemaLock(current, schemaLock(current))
  const bundle = { config: current, runtime: current, migrations: [{ name: '0001_r1.sql', sql: initialSchema(current) }], indexes: [], fingerprint: '', guards: {} }
  const planned = prepare(current, [], [{ kind: 'set_locale', locale: 'en' }])
  const expected = await expectedSnapshot(bundle, planned)
  tamper.sql = sql
  const verification = await applyDisposable(bundle, planned, expected, false)
  expect(tamper.applied).toBe(true)
  expect(verification).toMatchObject({ verified: false, diffs: [{ code, details: { phase: 'verification', hint: expect.any(String) } }] })
})
