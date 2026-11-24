import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { WidgetCards } from '../src/dashboard'
import { RuntimeLocalization } from '../src/runtime-localization'
import type { ConsolePage, ConsolePageResult } from '@workbasehq/core/console-contract'

const page: ConsolePage = { id: 'labels', path: '/labels', label: 'overview', widgets: [
  { id: 'count', kind: 'stat', label: 'dashboard_count', query: { entity: 'specimens' }, aggregate: { fn: 'count' } },
  { id: 'table', kind: 'table', label: 'dashboard_table', query: { entity: 'specimens', select: ['id', 'name'], limit: 5 }, columns: ['name'] },
  { id: 'list', kind: 'list', label: 'dashboard_list', query: { entity: 'specimens', select: ['id', 'name'], limit: 5 }, field: 'name' },
  { id: 'fallback', kind: 'stat', label: 'entity_specimens', query: { entity: 'specimens' }, aggregate: { fn: 'count' } },
] }
const result: ConsolePageResult = { id: page.id, label: page.label, widgets: [
  { id: 'count', label: 'dashboard_count', kind: 'stat', value: 1 },
  { id: 'table', label: 'dashboard_table', kind: 'table', columns: ['name'], data: [{ id: 'synthetic', name: 'Alex Example' }] },
  { id: 'list', label: 'dashboard_list', kind: 'list', field: 'name', data: [{ id: 'synthetic', name: 'Alex Example' }] },
  { id: 'fallback', label: 'entity_specimens', kind: 'stat', value: 1 },
] }
const enumLabels = {
  en: { dashboard_count: 'Specimen count', dashboard_table: 'Recent specimens', dashboard_list: 'Specimen names', entity_specimens: 'Specimens' },
  cs: { dashboard_count: 'Počet vzorků', dashboard_table: 'Nejnovější vzorky', dashboard_list: 'Názvy vzorků', entity_specimens: 'Vzorky' },
}
it.each(['en', 'cs'] as const)('renders stat/table/list captions and entity fallback through the scoped %s dictionary', async language => {
  const i18n = createInstance()
  await i18n.init({ lng: language, resources: {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['console-model', 'org-a'], { model: { enumLabels } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RuntimeLocalization orgId="org-a"><WidgetCards orgId="org-a" page={page} result={result} pending={false} error={null} enumLabels={enumLabels} /></RuntimeLocalization></QueryClientProvider></I18nextProvider>)
  for (const caption of Object.values(enumLabels[language])) expect(screen.getByRole('heading', { level: 2, name: caption })).toBeTruthy()
  expect(screen.getByRole('table', { name: enumLabels[language].dashboard_table })).toBeTruthy()
  client.clear()
})

it.each([
  ['en', { cs: { dashboard_count: 'Pouze česky' } }, 'Pouze česky'],
  ['cs', { en: { dashboard_count: 'English only' } }, 'English only'],
  ['en', { en: { dashboard_count: '' }, cs: { dashboard_count: 'Záložní popisek' } }, 'Záložní popisek'],
  ['cs', { en: { dashboard_count: '  ' }, cs: { dashboard_count: '' } }, 'dashboard_count'],
  ['en', {}, 'dashboard_count'],
  ['cs', {}, 'dashboard_count'],
] as const)('uses compatible widget-caption fallback in %s (%j)', async (language, labels, expected) => {
  const i18n = createInstance()
  await i18n.init({ lng: language, resources: {} })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['console-model', 'org-a'], { model: { enumLabels: labels } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RuntimeLocalization orgId="org-a"><WidgetCards orgId="org-a" page={page} result={result} pending={false} error={null} enumLabels={labels} /></RuntimeLocalization></QueryClientProvider></I18nextProvider>)
  expect(screen.getByRole('heading', { level: 2, name: expected })).toBeTruthy()
  client.clear()
})

it.each(['Free form caption', 'missing_key', 'entity_missing', 'overview'])('renders an unconfigured label literally: %s', async label => {
  const i18n = createInstance()
  await i18n.init({ lng: 'en', resources: { en: { translation: { overview: 'Built-in overview' } } } })
  render(<I18nextProvider i18n={i18n}><WidgetCards orgId="org-a" page={page} result={{ ...result, widgets: [{ id: 'count', kind: 'stat', value: 1, label }] }} pending={false} error={null} /></I18nextProvider>)
  expect(screen.getByRole('heading', { level: 2, name: label })).toBeTruthy()
})
