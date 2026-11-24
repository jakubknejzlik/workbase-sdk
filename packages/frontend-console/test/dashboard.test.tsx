import { expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { WidgetCards } from '../src/dashboard'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

it.each(['en', 'cs'] as const)('renders one compact %s error alongside healthy cards', async language => {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: en }, cs: { translation: cs } }, interpolation: { escapeValue: false } })
  const copy = language === 'cs' ? cs : en
  const { container } = render(<I18nextProvider i18n={i18n}><WidgetCards orgId="org-a" page={{ id: 'summary', path: '/summary', label: 'Summary' }} pending={false} error={null}
    result={{ id: 'summary', label: 'Summary', sections: [{ row: ['count', 'refused'] }], widgets: [
      { id: 'count', label: 'Job count', kind: 'stat', value: 3 },
      { id: 'refused', label: 'Recent jobs', kind: 'error', code: 'query_too_expensive' },
      { id: 'plain', label: 'Job titles', kind: 'list', field: 'title', data: [{ title: 'Alex Example' }] },
    ] }} /></I18nextProvider>)
  expect(within(screen.getByRole('alert')).getByText(copy.dashboardWidgetFailed)).toBeTruthy()
  expect(screen.getByText(copy.dashboardWidgetErrorCode.replace('{{code}}', 'query_too_expensive'))).toBeTruthy()
  expect(screen.getByText('3')).toBeTruthy()
  expect(screen.getByText('Alex Example')).toBeTruthy()
  expect(container.querySelectorAll('[data-widget]')).toHaveLength(3)
})
