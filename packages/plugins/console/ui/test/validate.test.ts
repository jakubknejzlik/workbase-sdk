import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import { validateInstance } from '../src/check'
import { effectiveSpans } from '../src/validate'
import { scanTSX } from '../src/scan'
import { instanceFixture } from './fixture'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function setup() { const f = instanceFixture(); roots.push(f.root); return f }
function edit(f: ReturnType<typeof setup>, file: string, transform: (s: string) => string) { f.put(file, transform(readFileSync(join(f.root, file), 'utf8'))) }
function catalog(f: ReturnType<typeof setup>, lang: string, ns: string, transform: (c: Record<string, string>) => void) {
  edit(f, `locales/${lang}/${ns}.json`, text => { const c = JSON.parse(text); transform(c); return JSON.stringify(c, null, 2) })
}
const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts['check:ui']
function cli(root: string) { return spawnSync('sh', ['-c', command + ' "$1"', 'check-ui', root], { encoding: 'utf8' }) }
test('committed four-route cs/en Instance passes the exported validator and command', async () => {
  const f = setup()
  expect(await validateInstance(f.root)).toEqual([])
  expect(cli(f.root).status).toBe(0)
})
test.each(['cs', 'en'])('P3 actual check:ui command rejects deleted %s title with consumer source', lang => {
  const f = setup()
  catalog(f, lang, 'ui', c => { delete c['workers.list.title'] })
  const result = cli(f.root), output = result.stdout + result.stderr
  expect(result.status).not.toBe(0)
  expect(output).toContain('workers.list.title')
  expect(output).toContain(`locales/${lang}/ui.json:`)
  expect(output).toMatch(/ui\/workers\/index.ts:2:\d+/)
})
test.each([
  ['missing-cs', 'missing-key', (f: ReturnType<typeof setup>) => catalog(f, 'cs', 'ui', c => { delete c['workers.edit.title'] })],
  ['missing-en', 'missing-key', (f: ReturnType<typeof setup>) => catalog(f, 'en', 'ui', c => { delete c['workers.edit.title'] })],
  ...['one', 'few', 'many', 'other'].map(category => ['cs-' + category, 'missing-key', (f: ReturnType<typeof setup>) => catalog(f, 'cs', 'domain', c => { delete c['entity.worker_' + category] })] as const),
  ['interpolation', 'interpolation', (f: ReturnType<typeof setup>) => catalog(f, 'en', 'ui', c => { c['workers.edit.title'] = 'Edit {{who}}' })],
  ['orphan', 'orphan-key', (f: ReturnType<typeof setup>) => catalog(f, 'en', 'ui', c => { c['unused.key'] = 'unused' })],
  ['unused family', 'unused-family', (f: ReturnType<typeof setup>) => edit(f, 'ui/keys.ts', s => s.replace('{}', "{ 'workers.badge': ['active', 'off'] }"))],
  ['unknown override', 'unknown-sdk-key', (f: ReturnType<typeof setup>) => f.put('locales/en/sdk.json', '{"unknown":"Unknown"}')],
  ['nested translation', 'nested-translation', (f: ReturnType<typeof setup>) => catalog(f, 'cs', 'ui', c => { c['workers.edit.title'] = '$t(workers.list.title)' })],
] as const)('dictionary rejection: %s', async (_name, code, mutate) => {
  const f = setup(); mutate(f)
  const findings = await validateInstance(f.root)
  expect(findings).toHaveLength(1)
  expect(findings[0]).toMatchObject({ code, line: expect.any(Number), col: expect.any(Number) })
  expect(findings[0].file.startsWith(f.root)).toBe(true)
})
test.each([
  ['form-only removal', 'unplaced-field', (s: string) => s.replace("col('name', { md: 8 }), ", '')],
  ['unknown omit', 'unknown-omit', undefined],
  ['bare userLink', 'bare-userLink', undefined],
] as const)('structural rejection: %s', async (name, code, change) => {
  const f = setup()
  if (change) edit(f, 'ui/workers/-form.layout.ts', change)
  else if (name === 'unknown omit') edit(f, 'ui/workers/new.ts', s => s.replace("['user']", "['user', 'missing']"))
  else edit(f, 'ui/workers/-detail.layout.ts', s => s.replace("slot('fieldValue', { value: 'user' })", "'user'"))
  const findings = await validateInstance(f.root)
  expect(findings.every(f => f.code === code)).toBe(true); expect(findings.length).toBeGreaterThan(0)
})
test.each(['xs', 'sm', 'md', 'lg', 'xl'])('row overflow at %s is located and blocking', async bp => {
  const f = setup()
  f.put('ui/workers/-form.layout.ts', `import { col, type Node } from '@workbasehq/plugins/console/ui'\nexport default [{ kind: 'row', children: [col('name', { ${bp}: 8 }), col('status', { ${bp}: 5 })] }] satisfies Node[]`)
  const findings = await validateInstance(f.root)
  expect(findings).toContainEqual(expect.objectContaining({ code: 'row-overflow', message: bp, line: 3 }))
})
test('mobile-first inheritance and stacked exemption, bounds and col placement', async () => {
  expect(effectiveSpans({ md: 8, xl: 6 })).toEqual([12, 12, 8, 8, 6])
  const f = setup()
  f.put('ui/workers/-form.layout.ts', `import { col, type Node } from '@workbasehq/plugins/console/ui'\nexport default [{ kind: 'row', children: [col('name', 12), col('status', 12)] }] satisfies Node[]`)
  expect(await validateInstance(f.root)).toEqual([])
  edit(f, 'ui/workers/-form.layout.ts', s => s.replace("col('name', 12)", "col('name', 13)"))
  expect(await validateInstance(f.root)).toContainEqual(expect.objectContaining({ code: 'span-bounds' }))
  f.put('ui/workers/-form.layout.ts', `import { col } from '@workbasehq/plugins/console/ui'\nexport default [col('name', 12), 'status']`)
  expect(await validateInstance(f.root)).toContainEqual(expect.objectContaining({ code: 'col-parent' }))
})
test('existing nav resolver is reached by the CLI', () => {
  const f = setup(); rmSync(join(f.root, 'ui/workers/index.ts'))
  const result = cli(f.root)
  expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/nav.ts:2:.*Missing or ambiguous page: worker.list/)
})
test('collects all independent findings in deterministic location order', async () => {
  const f = setup()
  for (const lang of ['cs', 'en']) catalog(f, lang, 'ui', c => { delete c['workers.list.title']; c['orphan.key'] = 'unused' })
  const a = await validateInstance(f.root), b = await validateInstance(f.root)
  expect(a).toEqual(b); expect(a).toHaveLength(4)
  expect(a.map(f => f.lang)).toEqual(['cs', 'cs', 'en', 'en'])
})
test('finite dynamic families and literal TSX calls build their key inventory', () => {
  const scan = scanTSX(new Map([['sample.tsx', "import { t } from '@workbasehq/plugins/console/ui/i18n'; t('workers.title'); t(`workers.badge.${state}`); t(variable)"]]), { 'workers.badge': ['active', 'off'] })
  expect([...scan.keys.keys()]).toEqual(['ui:workers.title']); expect([...scan.families]).toEqual(['workers.badge'])
  expect(scan.findings.map(f => f.code)).toEqual(['dynamic-key'])
})
test('admitted TSX bare text reaches the actual CLI', () => {
  const f = setup()
  f.put('ui/-components/FieldValue.tsx', 'export default function FieldValue() { return <p>Untranslated</p> }')
  const result = cli(f.root)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/FieldValue.tsx:1:\d+.*bare-text/)
})
