// @vitest-environment jsdom
import { createElement as h } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createI18n, initI18n, resolveLanguage, sdkCatalogs, t } from '../src/i18n'
import { ConsoleProvider, LanguageSwitcher, PageView } from '../src/react'
import { page } from '../src/index'
import { checkDictionaries } from '../src/dictionaries'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
test('missing key in DOM is a marker, never English, humanised text or a supplied default', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const i18n = initI18n({ languages: ['cs', 'en'], catalogs: { en: { ui: { 'missing.title': 'English fallback' } } } })
  const definition = page({ title: 'missing.title' })
  render(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'o' }, t: i18n.t }, h(PageView, { definition, route: { ...definition, source: 'ui/index.ts', path: '/', links: {} }, entities: {}, params: {}, search: {}, navigate: () => {} })))
  expect(screen.getByRole('heading', { name: '⟦ui:missing.title⟧' })).toBeTruthy()
  expect(t('missing.title', { defaultValue: 'Fallback', lng: 'en' })).toBe('⟦ui:missing.title⟧')
  expect(log).toHaveBeenCalledWith('Missing translation: ui:missing.title')
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
  const definition = page({ title: 'page.title' })
  render(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'o' }, t: i18n.t, i18n }, h(LanguageSwitcher, { i18n }), h(PageView, { definition, route: { ...definition, source: 'ui/index.ts', path: '/', links: {} }, entities: {}, params: {}, search: {}, navigate: () => {} })))
  fireEvent.change(screen.getByLabelText('Jazyk'), { target: { value: 'en' } })
  expect(await screen.findByRole('heading', { name: 'English' })).toBeTruthy()
  cleanup(); render(h(LanguageSwitcher, { i18n: createI18n({ languages: ['en'], catalogs: {} }) }))
  expect(screen.queryByRole('combobox')).toBeNull()
})
