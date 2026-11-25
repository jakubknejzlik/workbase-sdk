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

const layoutWidgets: ConsoleWidgetResult[] = [
  { id: 'total', label: 'Total', kind: 'stat', value: 0 },
  { id: 'attention', label: 'Attention', kind: 'list', field: 'name', data: [] },
  { id: 'other', label: 'Other', kind: 'stat', value: null },
]

it.each(['en', 'cs'])('uses configured attention-first DOM order without omitted section cells (%s)', async language => {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: en }, cs: { translation: cs } } })
  const { container } = render(<I18nextProvider i18n={i18n}><WidgetCards orgId="org-a" page={{ id: 'summary', path: '/summary', label: 'Summary' }} pending={false} error={null}
    result={{ id: 'summary', label: 'Summary', sections: [{ row: ['denied'] }, { row: ['attention', 'denied'] }, { row: ['total'] }], widgets: layoutWidgets }} /></I18nextProvider>)
  expect(Array.from(container.querySelectorAll('[data-widget]'), node => node.getAttribute('data-widget'))).toEqual(['attention', 'total', 'other'])
  expect(Array.from(container.querySelectorAll('[data-dashboard-row]'), node => node.children.length)).toEqual([1, 1, 1])
  expect(container.querySelector('[data-dashboard-columns="2"]')).toBeNull()
  expect(container.querySelector('[data-widget="total"]')?.textContent).toContain('0')
})

it.each([undefined, []])('preserves legacy unspecified widget order with sections %j', sections => {
  const { container } = render(<WidgetCards orgId="org-a" page={{ id: 'summary', path: '/summary', label: 'Summary' }} pending={false} error={null}
    result={{ id: 'summary', label: 'Summary', sections, widgets: layoutWidgets }} />)
  expect(Array.from(container.querySelectorAll('[data-widget]'), node => node.getAttribute('data-widget'))).toEqual(['total', 'attention', 'other'])
})

it('uses configured sections while pending, then only the authorized response sections and widgets', () => {
  const page = { id: 'summary', path: '/summary', label: 'Summary', sections: [{ row: ['attention', 'total'] }], widgets: [
    { id: 'total', label: 'Total', kind: 'stat' as const, query: { entity: 'jobs' }, aggregate: { fn: 'count' as const } },
    { id: 'attention', label: 'Attention', kind: 'list' as const, query: { entity: 'jobs', select: ['name'], limit: 5 }, field: 'name' },
  ] }
  const { container, rerender } = render(<WidgetCards orgId="org-a" page={page} pending error={null} />)
  expect(Array.from(container.querySelectorAll('[data-widget]'), node => node.getAttribute('data-widget'))).toEqual(['attention', 'total'])
  expect(screen.getAllByRole('status')).toHaveLength(2)
  rerender(<WidgetCards orgId="org-a" page={page} pending={false} error={null} result={{ id: 'summary', label: 'Summary', widgets: [layoutWidgets[0]] }} />)
  expect(container.querySelectorAll('[data-widget]')).toHaveLength(1)
  expect(container.querySelector('[data-widget="attention"]')).toBeNull()
  expect(container.querySelectorAll('[data-dashboard-row]')).toHaveLength(1)
})
