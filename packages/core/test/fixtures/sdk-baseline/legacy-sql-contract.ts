import { expect } from 'vitest'
import { CORE_VERSION } from '../../../src/config'
import { sha256 } from '../../../src/crypto'
import { revisionSQL } from '../../../src/migrations/schema'
import released from './released-1d09aee4.json'

/** Check today's stamp, then compare historical bytes under their explicit stamp. */
export function legacySQLAtHistoricalStamp(sql: string, revision: number) {
  const historicalStamp = `INSERT INTO instance_meta VALUES (${revision}, '0.2.15', strftime('%Y-%m-%dT%H:%M:%fZ','now'));\n`
  const currentStamp = `INSERT INTO instance_meta VALUES (${revision}, '${CORE_VERSION}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));\n`
  expect(revisionSQL(revision) + '\n').toBe(currentStamp)
  expect(sql.endsWith(currentStamp)).toBe(true)
  // Only the one explicit trailing revision value may differ. All other bytes,
  // including whitespace, must still equal the released SQL under its stamp.
  return sql.slice(0, -currentStamp.length) + historicalStamp
}

/** Pin historical structure without mistaking a fresh SDK stamp for history drift. */
export async function expectLegacyInitialSQL(sql: string) {
  // Keep the historical checksum: it identifies the retained migration file and
  // is compared against _migrations on upgrade. Never re-pin it for a new SDK.
  expect(await sha256(released.files[0].sql)).toBe('e9f01a0c333eeac9ae63a449fac1691bad86f1172403dcf797481ebc3f86e544')
  expect(released.files[0].checksum).toBe(await sha256(released.files[0].sql))
  expect(legacySQLAtHistoricalStamp(sql, 1)).toBe(released.files[0].sql)
}
