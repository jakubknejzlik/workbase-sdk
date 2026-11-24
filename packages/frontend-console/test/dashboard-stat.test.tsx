import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { ConsoleAggregate, ConsolePage, ConsoleWidgetResult } from '../../core/src/console-contract'
import { WidgetCards } from '../src/dashboard'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

for (const language of ['en', 'cs'] as const) {
  const copy = language === 'cs' ? cs : en
  async function stat(value: number | null | undefined, aggregate: ConsoleAggregate) {
    const i18n = i18next.createInstance()
    await i18n.use(initReactI18next).init({ lng: language, resources: { [language]: { translation: copy } } })
    const page: ConsolePage = { id: 'summary', path: '/summary', label: 'Summary', widgets: [
      { id: 'total', label: 'Total', kind: 'stat', query: { entity: 'specimens' }, aggregate },
    ] }
    // An omitted wire value is missing data too, even though canonical responses use null.
    const widget = { id: 'total', label: 'Total', kind: 'stat', ...(value === undefined ? {} : { value }) } as ConsoleWidgetResult
    render(<I18nextProvider i18n={i18n}><WidgetCards orgId="org-a" page={page} result={{ id: page.id, label: page.label, widgets: [widget] }} pending={false} error={null} /></I18nextProvider>)
  }

  for (const aggregate of [{ fn: 'count' }, { fn: 'sum', field: 'quantity' }] as const) {
    it.each([0, 7, -3])(`${language} ${aggregate.fn}: %s renders only a value`, async value => {
      await stat(value, aggregate)
      expect(screen.getByText(new Intl.NumberFormat(language).format(value), { exact: true })).toBeTruthy()
      expect(screen.queryByText(copy.dashboardEmpty)).toBeNull()
    })
    it.each([null, undefined])(`${language} ${aggregate.fn}: %s renders the empty state without a number`, async value => {
      await stat(value, aggregate)
      expect(screen.getByText(copy.dashboardEmpty)).toBeTruthy()
      expect(screen.queryByText('0', { exact: true })).toBeNull()
      expect(screen.queryByText('NaN', { exact: true })).toBeNull()
    })
  }
}
