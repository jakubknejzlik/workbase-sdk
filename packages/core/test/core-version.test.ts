import { describe, expect, it } from 'vitest'
import manifest from '../package.json' with { type: 'json' }
import { CORE_VERSION } from '../src/config'

describe('CORE_VERSION', () => {
  it('matches the published @workbasehq/core manifest version', () => {
    expect(CORE_VERSION).toBe(manifest.version)
  })
})
