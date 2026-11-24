import { expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { WidgetCards } from '../src/dashboard'
import type { ConsoleWidgetResult } from '../../plugins/console/src/contract'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

it.each((['en', 'cs'] as const).flatMap(language => ['query_too_expensive', 'widget_failed', 'future_error'].map(code => ({ language, code }))))('renders a compact $language error for $code alongside healthy cards', async ({ language, code }) => {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: en }, cs: { translation: cs } }, interpolation: { escapeValue: false } })
  const copy = language === 'cs' ? cs : en
  const { container } = render(<I18nextProvider i18n={i18n}><WidgetCards orgId="org-a" page={{ id: 'summary', path: '/summary', label: 'Summary' }} pending={false} error={null}
    result={{ id: 'summary', label: 'Summary', sections: [{ row: ['count', 'refused'] }], widgets: [
      { id: 'count', label: 'Job count', kind: 'stat', value: 3 },
      // A future server code must remain safe even before the client contract knows it.
      { id: 'refused', label: 'Recent jobs', kind: 'error', code } as ConsoleWidgetResult,
      { id: 'plain', label: 'Job titles', kind: 'list', field: 'title', data: [{ title: 'Alex Example' }] },
    ] }} /></I18nextProvider>)
  const alert = screen.getByRole('alert')
  expect(within(alert).getByText(copy.dashboardWidgetFailed)).toBeTruthy()
  expect(within(alert).getByText(code === 'query_too_expensive' ? copy.dashboardWidgetTooComplex : copy.dashboardWidgetRetry)).toBeTruthy()
  expect(alert.getAttribute('data-error-code')).toBe(code)
  expect(container.textContent).not.toMatch(/query_too_expensive|widget_failed|future_error/)
  expect(screen.getByText('3')).toBeTruthy()
  expect(screen.getByText('Alex Example')).toBeTruthy()
  expect(container.querySelectorAll('[data-widget]')).toHaveLength(3)
})
