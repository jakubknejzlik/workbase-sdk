import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { scanTSX } from '../src/scan'
const sdkImport = "import { t } from '@workbasehq/plugins/console/ui/i18n';\n"
const scan = (code: string) => scanTSX(new Map([['ui/-components/probe.tsx', code]]), {})
test.each([
  ['JsxText', '<p>Hello</p>'], ['unicode text', '<p>Žluťoučký</p>'],
  ['string child', '<p>{"Hello"}</p>'], ['template child', '<p>{`Hello ${name}`}</p>'],
  ['and', '<p>{ok && "Hello"}</p>'], ['or', '<p>{ok || "Hello"}</p>'],
  ['or left', '<p>{"Hello" || ok}</p>'], ['conditional true', '<p>{ok ? "Hello" : value}</p>'],
  ['conditional false', '<p>{ok ? value : `Hello`}</p>'], ['nested', '<p>{ok && (other ? value : "Hello")}</p>'],
  ...['title', 'alt', 'placeholder', 'label', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext'].flatMap(attr => [[attr, `<input ${attr}="Hello" />`], [attr + ' expression', `<input ${attr}={ok ? value : 'Hello'} />`]]),
])('TSX rejects one located literal: %s', (_name, jsx) => {
  const findings = scan(sdkImport + 'export default () => ' + jsx).findings
  expect(findings).toHaveLength(1)
  expect(findings[0]).toMatchObject({ code: 'bare-text', file: 'ui/-components/probe.tsx', line: 2, col: expect.any(Number) })
})
test.each([
  "const t = (x: string) => x; const node = <p>{t('hello')}</p>",
  "import { t } from 'other'; const node = <p>{t('hello')}</p>",
  sdkImport + "function Component(t: (s: string) => string) { return <p>{t('hello')}</p> }",
  "import type { t } from '@workbasehq/plugins/console/ui/i18n'; t('hello')",
])('t must resolve to the SDK import, including shadowing', code => {
  expect(scan(code).findings.map(f => f.code)).toEqual(['unbound-t'])
})
test('SDK import aliases work; documented data-flow exclusions and punctuation pass', () => {
  const result = scan("import { t as translate } from '@workbasehq/plugins/console/ui/i18n'; const node = <><p title={translate('hello')}>{translate('sdk:save')} ! {value}{helper('text')}</p><Widget other='Text' /></>")
  expect(result.findings).toEqual([]); expect([...result.keys.keys()]).toEqual(['ui:hello', 'sdk:save'])
})
test('same authored-text rule accepts the SDK renderer', () => {
  const file = 'packages/plugins/console/ui/src/react/index.ts'
  // The renderer uses createElement; parsing as TSX applies the exact same rule.
  expect(scanTSX(new Map([[file + 'x', readFileSync(file, 'utf8')]]), {}).findings).toEqual([])
})
