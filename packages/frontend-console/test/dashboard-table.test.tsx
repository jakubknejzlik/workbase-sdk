import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { WidgetCards } from '../src/dashboard'
import type { Model, Capabilities } from '../../console-generated/src/read'
import type { ConsolePage, ConsoleWidgetResult } from '../../plugins/console/src/contract'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, params }: { children: ReactNode; params: { entity: string; id: string } }) => <a href={`/${params.entity}/${params.id}`}>{children}</a> }))
const model = { entities: {
  bookings: { fields: { client: { type: 'ref', entity: 'clients' }, amount: { type: 'int' }, updated_at: { type: 'datetime' } } },
  clients: { displayField: 'name', fields: { name: { type: 'string' } } },
} } as unknown as Model
const caps = { entities: { clients: { operations: ['read'], readable: ['id', 'name'] } } } as unknown as Capabilities
const page: ConsolePage = { id: 'summary', path: '/summary', label: 'Summary', widgets: [
  { id: 'bookings', label: 'Bookings', kind: 'table', query: { entity: 'bookings', select: ['client', 'amount', 'updated_at'], limit: 20 }, columns: ['client', 'amount', 'updated_at'] },
  { id: 'clients', label: 'Clients', kind: 'list', query: { entity: 'bookings', select: ['client'], limit: 20 }, field: 'client' },
] }
const row = { id: 'booking', client: 'client', amount: 42, updated_at: '2026-11-24T10:00:00.000Z', __labels: { client: { status: 'ok', entity: 'clients', row: { id: 'client', name: 'Alex Example' } } } }
async function mount(widgets: ConsoleWidgetResult[], language = 'en') {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { en: { translation: en }, cs: { translation: cs } } })
  render(<I18nextProvider i18n={i18n}><WidgetCards orgId="org" page={page} result={{ id: page.id, label: page.label, widgets }} pending={false} error={null} model={model} caps={caps} /></I18nextProvider>)
}
it.each(['en', 'cs'])('table and list keep all bounded rows and reference links in %s', async language => {
  const data = Array.from({ length: 12 }, (_, index) => ({ ...row, id: `booking-${index}` }))
  await mount([{ id: 'bookings', label: 'Bookings', kind: 'table', columns: ['client', 'amount', 'updated_at'], data }, { id: 'clients', label: 'Clients', kind: 'list', field: 'client', data }], language)
  for (const label of ['Bookings', 'Clients']) {
    const table = screen.getByRole('table', { name: label })
    expect(within(table).getAllByRole('row')).toHaveLength(13)
    expect(within(table).getAllByRole('link', { name: 'Alex Example' })).toHaveLength(12)
  }
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('searchbox')).toBeNull()
})
it('preserves empty and unavailable reference labels without exposing raw IDs', async () => {
  await mount([{ id: 'bookings', label: 'Bookings', kind: 'table', columns: ['client'], data: [
    { ...row, __labels: { client: { status: 'empty' } } },
    { ...row, id: 'denied', client: 'private-reference', __labels: { client: { status: 'unavailable' } } },
  ] }])
  expect(screen.getByText('—')).toBeTruthy()
  expect(screen.getByText(en.unavailableRecord)).toBeTruthy()
  expect(screen.queryByText('private-reference')).toBeNull()
})
it('retains empty feedback and mounts only returned widgets', async () => {
  await mount([{ id: 'clients', label: 'Clients', kind: 'list', field: 'client', data: [] }])
  expect(screen.getByText(en.dashboardEmpty)).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Bookings' })).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
})
