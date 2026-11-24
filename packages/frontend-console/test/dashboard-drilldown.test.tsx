import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { Model, Capabilities } from '../../console-generated/src/read'
import type { ConsolePage, ConsoleWidgetResult } from '../../plugins/console/src/contract'
import { WidgetCards } from '../src/dashboard'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

afterEach(() => { vi.restoreAllMocks() })
async function mount(options: { kind?: 'table' | 'list'; select?: string[]; id?: unknown; operations?: string[]; readable?: string[]; missingEntity?: boolean; language?: 'en' | 'cs'; referenceFirst?: boolean } = {}) {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const entity = { displayField: 'name', fields: { id: { type: 'string' as const }, name: { type: 'string' as const }, reviewer: { type: 'ref' as const, entity: 'people' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } }
  const model: Model = { instance: 'widget-tests', revision: 1, limits: { root: 100, children: 20, relations: 4, exists: 4 }, entities: { ...(!options.missingEntity ? { entries: entity } : {}), people: entity } }
  const caps: Capabilities = { revision: 1, entities: { entries: { operations: options.operations ?? ['read'], readable: options.readable ?? ['id', 'name', 'reviewer'], writable: [] }, people: { operations: ['read'], readable: ['id', 'name'], writable: [] } } }
  const row = { id: 'entry /α', name: 'Alex Example', reviewer: 'reviewer', __labels: { reviewer: { status: 'ok', entity: 'people', row: { id: 'reviewer', name: 'Sam Example' } } } }
  if (Object.hasOwn(options, 'id')) Object.assign(row, { id: options.id })
  const kind = options.kind ?? 'table'
  const columns = options.referenceFirst ? ['reviewer', 'name'] : ['name', 'reviewer']
  const query = { entity: 'entries', select: options.select ?? ['id', 'name', 'reviewer'], labels: ['reviewer'], limit: 5 }
  const page: ConsolePage = { id: 'summary', path: '/summary', label: 'Summary', widgets: [kind === 'table' ? { id: 'records', label: 'Records', kind, query, columns } : { id: 'records', label: 'Records', kind, query, field: 'name' }] }
  const widget: ConsoleWidgetResult = kind === 'table' ? { id: 'records', label: 'Records', kind, columns, data: [row] } : { id: 'records', label: 'Records', kind, field: 'name', data: [row] }
  const root = createRootRoute()
  const dashboard = createRoute({ getParentRoute: () => root, path: '/summary', component: () => <WidgetCards orgId="org /α" page={page} result={{ id: page.id, label: page.label, widgets: [widget] }} pending={false} error={null} model={model} caps={caps} /> })
  const detail = createRoute({ getParentRoute: () => root, path: '/o/$orgId/e/$entity/$id', component: () => <h1>Record detail</h1> })
  const router = createRouter({ routeTree: root.addChildren([dashboard, detail]), history: createMemoryHistory({ initialEntries: ['/summary'] }) })
  await router.load()
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: options.language ?? 'en', resources: { en: { translation: en }, cs: { translation: cs } } })
  const rendered = render(<I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider>)
  await screen.findAllByText('Alex Example')
  return { ...rendered, router, user: userEvent.setup() }
}

it.each(['table', 'list'] as const)('links the permitted primary %s value using the console detail route and accessible name', async kind => {
  const { container } = await mount({ kind })
  const links = screen.getAllByRole('link', { name: 'Alex Example' })
  expect(links).toHaveLength(kind === 'table' ? 2 : 1)
  for (const link of links) expect(link.getAttribute('href')).toBe('/o/org%20%2F%CE%B1/e/entries/entry%20%2F%CE%B1')
  expect(container.querySelector('a a')).toBeNull()
})

it.each(['table', 'list'] as const)('allows Tab and Enter to open the %s primary record', async kind => {
  const { user, router } = await mount({ kind })
  await user.tab()
  expect(document.activeElement).toBe(screen.getAllByRole('link', { name: 'Alex Example' })[0])
  await user.keyboard('{Enter}')
  await screen.findByRole('heading', { name: 'Record detail' })
  expect(router.state.matches.at(-1)?.params).toEqual({ orgId: 'org /α', entity: 'entries', id: 'entry /α' })
})

for (const kind of ['table', 'list'] as const) it.each([
  { operations: [] }, { operations: ['update'] }, { readable: ['name', 'reviewer'] }, { missingEntity: true },
  { select: ['name', 'reviewer'] }, { id: undefined }, { id: null }, { id: '' },
])(`keeps ${kind} text without a dead primary link: %j`, async options => {
  await mount({ ...options, kind })
  expect(screen.queryByRole('link', { name: 'Alex Example' })).toBeNull()
})

it.each([false, true])('preserves reference-label destinations and avoids nested links (reference first: %s)', async referenceFirst => {
  const { container } = await mount({ referenceFirst })
  const links = screen.getAllByRole('link', { name: 'Sam Example' })
  expect(links).toHaveLength(2)
  for (const link of links) expect(link.getAttribute('href')).toBe('/o/org%20%2F%CE%B1/e/people/reviewer')
  expect(screen.getAllByRole('link', { name: 'Alex Example' })).toHaveLength(2)
  expect(within(container.querySelector('tbody')!).getAllByRole('link')).toHaveLength(2)
  expect(container.querySelector('a a')).toBeNull()
})

it('retains reference links when the primary detail is denied', async () => {
  await mount({ operations: [] })
  expect(screen.queryByRole('link', { name: 'Alex Example' })).toBeNull()
  expect(screen.getAllByRole('link', { name: 'Sam Example' })).toHaveLength(2)
})

it('retains the same primary accessible name in Czech', async () => {
  await mount({ kind: 'list', language: 'cs' })
  await waitFor(() => expect(screen.getByRole('link', { name: 'Alex Example' })).toBeTruthy())
})
