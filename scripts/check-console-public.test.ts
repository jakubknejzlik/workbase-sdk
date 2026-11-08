import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { checkConsolePublic, privateLocaleKeys } from './check-console-public'
it.each(['tiketo', 'infodental', 'cleaning', 'service-requests', 'ControlDental', 'TeamVibe'])('public bundle scan rejects %s', content => {
  const directory = mkdtempSync(resolve(tmpdir(), 'console-scan-'))
  try { writeFileSync(resolve(directory, 'index.js'), `const label = ${JSON.stringify(content)}`); expect(() => checkConsolePublic(directory)).toThrow('forbidden public content') }
  finally { rmSync(directory, { recursive: true }) }
})
it('public bundle scan accepts generic and malformed data URIs', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'console-scan-'))
  try {
    const uri = `data:application/json;base64,${Buffer.from('{"label":"field_name"}').toString('base64')}`
    writeFileSync(resolve(directory, 'index.js'), `const assets = [${JSON.stringify(uri)}, "data:text/plain,%ZZ"]`)
    expect(checkConsolePublic(directory)).toContain('0 private model IDs')
  } finally { rmSync(directory, { recursive: true }) }
})
it('public bundle scan accepts generic labels and scans nested assets', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'console-scan-'))
  try { writeFileSync(resolve(directory, 'index.js'), 'const label = "field_name"'); expect(checkConsolePublic(directory)).toContain('0 private model IDs') }
  finally { rmSync(directory, { recursive: true }) }
})
it.each(['base64', 'percent'])('public bundle scan rejects %s data URI private content', encoding => {
  const directory = mkdtempSync(resolve(tmpdir(), 'console-scan-'))
  const content = JSON.stringify({ privateMarker: 'infodental' })
  const uri = encoding === 'base64'
    ? `data:application/json;base64,${Buffer.from(content).toString('base64')}`
    : `data:application/json,${[...Buffer.from(content)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('')}`
  try {
    writeFileSync(resolve(directory, 'index.js'), `const asset = ${JSON.stringify(uri)}`)
    expect(() => checkConsolePublic(directory)).toThrow('forbidden public content')
  } finally { rmSync(directory, { recursive: true }) }
})
it('allows only the exact component provenance notice', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'console-scan-'))
  const notice = readFileSync(resolve(import.meta.dirname, '../packages/plugins/console/NOTICE'), 'utf8')
  try {
    writeFileSync(resolve(directory, 'index.js'), 'const label = "field_name"')
    writeFileSync(resolve(directory, 'NOTICE'), notice)
    expect(checkConsolePublic(directory)).toContain('0 private model IDs')
    writeFileSync(resolve(directory, 'NOTICE'), notice + '\nControlDental\n')
    expect(() => checkConsolePublic(directory)).toThrow('forbidden public content')
    writeFileSync(resolve(directory, 'NOTICE'), '')
    writeFileSync(resolve(directory, 'index.js'), JSON.stringify(notice))
    expect(() => checkConsolePublic(directory)).toThrow('forbidden public content')
  } finally { rmSync(directory, { recursive: true }) }
})
it.each(['bundle.js.map', 'sourceMappingURL=data:application/json;base64,e30='])('rejects source map payload %s', value => {
  const directory = mkdtempSync(resolve(tmpdir(), 'console-scan-'))
  try {
    writeFileSync(resolve(directory, 'index.js'), value.includes('=') ? `//# ${value}` : '')
    if (value.endsWith('.map')) writeFileSync(resolve(directory, value), '{"sources":["/private/checkout.ts"]}')
    expect(() => checkConsolePublic(directory)).toThrow(/source map/)
  } finally { rmSync(directory, { recursive: true }) }
})

it('skips missing private catalogs, retains present keys and rejects malformed catalogs', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'console-catalogs-'))
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect([...privateLocaleKeys(root, new Set())]).toEqual([])
    expect(log).toHaveBeenCalledTimes(4)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipping absent private locale input'))
    const directory = resolve(root, 'packages/frontend-console/fixtures/private/locales')
    mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, 'en.json'), JSON.stringify({ generic: 'Generic', privateKey: 'Private' }))
    expect([...privateLocaleKeys(root, new Set(['generic']))]).toEqual(['privateKey'])
    writeFileSync(resolve(directory, 'en.json'), '{broken')
    expect(() => privateLocaleKeys(root, new Set())).toThrow()
  } finally { log.mockRestore(); rmSync(root, { recursive: true }) }
})
