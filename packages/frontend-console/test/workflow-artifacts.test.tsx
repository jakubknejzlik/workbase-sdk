import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertNoSecrets, redactAuthorization } from '../e2e/runtime/workflow-artifacts'

describe('C5 retained credentials', () => {
  it('rejects credentials in configs and nested logs without printing their values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-check-'))
    const secret = 'synthetic-control-credential'
    try {
      mkdirSync(join(directory, 'logs'))
      for (const path of ['wrangler.json', 'logs/worker.log']) {
        writeFileSync(join(directory, path), secret)
        expect(() => assertNoSecrets(directory, [secret])).toThrow(`Fixture secret retained in: ${join(directory, path)}`)
        try { assertNoSecrets(directory, [secret]) } catch (error) { expect(String(error)).not.toContain(secret) }
        rmSync(join(directory, path))
      }
      writeFileSync(join(directory, 'wrangler.json'), '{"secrets":{"required":["C5_CONTROL_TOKEN"]}}')
      expect(() => assertNoSecrets(directory, [secret])).not.toThrow()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('redacts JSON trace headers and plain request logs while preserving diagnostics', () => {
    const secret = 'synthetic-control-credential'
    const header = JSON.stringify({ name: 'Authorization', value: `Bearer ${secret}` })
    expect(JSON.parse(redactAuthorization(header))).toEqual({ name: 'Authorization', value: 'Bearer [REDACTED]' })
    expect(redactAuthorization(`POST /__test/c5\nAuthorization: Bearer ${secret}\n409`)).toBe('POST /__test/c5\nAuthorization: Bearer [REDACTED]\n409')
  })
})
