// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { createElement as h, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createI18n, initI18n, resolveLanguage, sdkCatalogs, t } from '../src/i18n'
import { ConsoleProvider, LanguageSwitcher, PageView } from '../src/react'
import { customPage } from '../src/index'
import { checkDictionaries } from '../src/dictionaries'
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(node: ReactNode): string }
afterEach(() => { cleanup(); vi.restoreAllMocks() })
test('authored t requires initialization', () => {
  expect(() => t('page.title')).toThrow('initI18n is required before rendering authored TSX')
})
test('missing key in DOM is a marker, never English, humanised text or a supplied default', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const i18n = initI18n({ languages: ['cs', 'en'], catalogs: { en: { ui: { 'missing.title': 'English fallback' } } } })
  function Authored() { return h('p', null, t('missing.title', { defaultValue: 'Fallback', lng: 'en' })) }
  const definition = customPage({ title: 'missing.title', uses: [], component: Authored })
  render(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'o' }, t: i18n.t }, h(PageView, { definition, route: { ...definition, source: 'ui/index.ts', path: '/', links: {} }, entities: {}, params: {}, search: {}, navigate: () => {} })))
  expect(screen.getByRole('heading', { name: '⟦ui:missing.title⟧' })).toBeTruthy()
  expect(screen.getByText('⟦ui:missing.title⟧', { selector: 'p' })).toBeTruthy()
  expect(i18n.t('missing.title', { defaultValue: 'Fallback', lng: 'en' })).toBe('⟦ui:missing.title⟧')
  expect(log).toHaveBeenCalledWith('Missing translation: ui:missing.title')
})
test('authored custom pages stay bound to their consuming Instance across SSR renders', () => {
  const options = (copy: string) => ({ languages: ['en'], catalogs: { en: { ui: { 'page.title': copy } } } })
  function Authored() { return h('p', null, t('page.title')) }
  const definition = customPage({ title: 'page.title', uses: [], component: Authored })
  const renderPage = (i18n: ReturnType<typeof initI18n>) => renderToStaticMarkup(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'o' }, t: i18n.t, i18n }, h(PageView, { definition, route: { ...definition, source: 'ui/index.ts', path: '/', links: {} }, entities: {}, params: {}, search: {}, navigate: () => {} })))
  const a = initI18n(options('INSTANCE A'))
  expect(renderPage(a)).toBe('<main><h1>INSTANCE A</h1><p>INSTANCE A</p></main>')
  const b = initI18n(options('INSTANCE B'))
  expect(renderPage(a)).toBe('<main><h1>INSTANCE A</h1><p>INSTANCE A</p></main>')
  expect(renderPage(b)).toBe('<main><h1>INSTANCE B</h1><p>INSTANCE B</p></main>')
  expect(a.t('page.title')).toBe('INSTANCE A')
  expect(b.t('page.title')).toBe('INSTANCE B')
  expect(() => renderToStaticMarkup(h(Authored))).toThrow('ConsoleProvider is required for authored t')
})
test('flat namespaces, Intl plurals and interpolation use i18next', async () => {
  const ui = { greeting: 'Ahoj {{name}}', item_one: '{{count}} kus', item_few: '{{count}} kusy', item_many: '{{count}} kusu', item_other: '{{count}} kusů' }
  const i18n = createI18n({ languages: ['cs'], catalogs: { cs: { ui } } })
  expect(i18n.t('greeting', { name: '<Eva>' })).toBe('Ahoj <Eva>')
  for (const [count, text] of [[1, '1 kus'], [3, '3 kusy'], [1.5, '1.5 kusu'], [8, '8 kusů']] as const) expect(i18n.t('item', { count })).toBe(text)
  expect(i18n.t('sdk:save')).toBe('Uložit')
  await expect(i18n.changeLanguage('de')).rejects.toThrow('Unconfigured language')
})
test('partial SDK override preserves other keys and accepts a variable subset', () => {
  const catalogs = { cs: { sdk: { save: 'Zapsat' } }, en: { sdk: { save: 'Store' } } }
  expect(checkDictionaries('/tmp', new Map(), catalogs, sdkCatalogs)).toEqual([])
  const i18n = createI18n({ languages: ['en', 'cs'], catalogs })
  expect(i18n.t('sdk:save')).toBe('Store'); expect(i18n.t('sdk:cancel')).toBe('Cancel')
  expect(checkDictionaries('/tmp', new Map(), { en: { sdk: { save: '{{extra}}' } } }, sdkCatalogs)).toContainEqual(expect.objectContaining({ code: 'override-interpolation' }))
})
test('SDK catalogs have identical inventories and interpolation sets', () => {
  const required = new Map(Object.keys(sdkCatalogs.en).map(key => ['sdk:' + key, []]))
  expect(Object.keys(sdkCatalogs.cs).sort()).toEqual(Object.keys(sdkCatalogs.en).sort())
  expect(checkDictionaries('/tmp', required, { cs: {}, en: {} }, sdkCatalogs)).toEqual([])
})
test('pure language resolver uses configured profile preference then first language', () => {
  expect(resolveLanguage({ language: 'en' }, ['cs', 'en'])).toBe('en')
  for (const profile of [null, undefined, {}, { language: 'de' }]) expect(resolveLanguage(profile, ['cs', 'en'])).toBe('cs')
  expect(() => resolveLanguage(null, [])).toThrow('At least one language')
})
test('switcher only appears for multiple languages and updates mounted page copy', async () => {
  const i18n = createI18n({ languages: ['cs', 'en'], catalogs: { cs: { ui: { 'page.title': 'Česky' } }, en: { ui: { 'page.title': 'English' } } } })
  function Authored() { return h('p', null, t('page.title')) }
  const definition = customPage({ title: 'page.title', uses: [], component: Authored })
  render(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'o' }, t: i18n.t, i18n }, h(LanguageSwitcher, { i18n }), h(PageView, { definition, route: { ...definition, source: 'ui/index.ts', path: '/', links: {} }, entities: {}, params: {}, search: {}, navigate: () => {} })))
  fireEvent.change(screen.getByLabelText('Jazyk'), { target: { value: 'en' } })
  expect(await screen.findByRole('heading', { name: 'English' })).toBeTruthy()
  expect(screen.getByText('English', { selector: 'p' })).toBeTruthy()
  cleanup(); render(h(LanguageSwitcher, { i18n: createI18n({ languages: ['en'], catalogs: {} }) }))
  expect(screen.queryByRole('combobox')).toBeNull()
})
