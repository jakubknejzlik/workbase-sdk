import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import { hideFieldByDefault } from '../../console-generated/src/default-hidden-fields'
import { shortRecordId } from '../../console-generated/src/labels'
import type { Model, Capabilities, ReadQuery, Result } from '../../console-generated/src/read'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}))
afterEach(() => vi.restoreAllMocks())
const id = '019a31c0-4a8a-7000-aaaa-123456789abc'
const name = 'Žofie Příkladová Dlouhá — ukázkový záznam'
async function mount(language: 'en' | 'cs' = 'en', title: string | null = name, hideId = false) {
  const labels = language === 'en' ? en : cs
  const model: Model = { instance: 'detail-identity', revision: 1, limits: { root: 100, children: 10, relations: 10, exists: 100 }, entities: {
    entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' } }, columns: ['name'], relations: {}, routes: { list: '', detail: '' } },
  } }
  if (hideId) model.entities.entries.fields.id.ui = { hidden: true }
  hideFieldByDefault(model.entities.entries.fields.id)
  let caps: Capabilities = { revision: 1, entities: { entries: { operations: ['read'], readable: ['id', 'name'], writable: [] } } }
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { [language]: { translation: { ...labels, field_id: 'ID' } } } })
  const row = { id, name: title }
  let next: (() => Promise<Result>) | undefined
  const request = vi.fn(async (query: ReadQuery): Promise<Result> => next ? next() : ({ data: [Object.fromEntries(query.select.map(field => [field, row[field as keyof typeof row]]))], next_cursor: null }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const element = () => <I18nextProvider i18n={i18n}><QueryClientProvider client={client}><GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" id={id} request={request} /></QueryClientProvider></I18nextProvider>
  const view = render(element())
  await screen.findByRole('heading', { name: title || shortRecordId(id) })
  return { ...view, client, labels, request, setNext: (read: () => Promise<Result>) => { next = read }, grants: (readable: string[], operations = ['read']) => {
    caps = { revision: caps.revision + 1, entities: { entries: { operations, readable, writable: [] } } }; view.rerender(element())
  } }
}

it.each(['en', 'cs'] as const)('%s keeps the human h1, secondary full ID, and copies through a native accessible button', async language => {
  const { container, labels, request } = await mount(language)
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(name)
  expect(container.querySelector('h1')?.parentElement?.parentElement?.querySelector('dl')?.textContent).toContain(id)
  expect(screen.getByText(id).closest('dd')).toBeTruthy()
  expect(request.mock.calls[0][0].select).toEqual(['id', 'name'])
  const button = screen.getByRole('button', { name: labels.listIdentifierCopy })
  fireEvent.click(button)
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(labels.listIdentifierCopied))
  expect(writeText).toHaveBeenCalledExactlyOnceWith(id)
  expect(button.getAttribute('type')).toBe('button')
  expect(button.closest('a')).toBeNull()
})

it.each(['denied', 'unavailable'] as const)('reports clipboard %s without announcing success', async failure => {
  const { labels } = await mount()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: failure === 'denied' ? { writeText: vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')) } : undefined })
  fireEvent.click(screen.getByRole('button', { name: labels.listIdentifierCopy }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(labels.listIdentifierCopyFailed))
})

it.each([null, ''] as const)('retains short-ID heading when the human label is %s', async title => {
  await mount('en', title)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(shortRecordId(id))
  expect(screen.getByText(id)).toBeTruthy()
})

it('remasks a retained human label, and removes ID/control immediately when id or entity read is revoked', async () => {
  const { grants, labels } = await mount()
  grants(['id'])
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(shortRecordId(id))
  expect(screen.queryByText(name)).toBeNull()
  await screen.findByRole('button', { name: labels.listIdentifierCopy })
  grants(['name'])
  expect(screen.queryByText(id)).toBeNull()
  expect(screen.queryByRole('button', { name: labels.listIdentifierCopy })).toBeNull()
  grants(['id', 'name'], [])
  expect(screen.queryByText(id)).toBeNull()
  expect(screen.queryByText(name)).toBeNull()
})

it('hides the secondary identity/control during a delayed refresh and after a failed read', async () => {
  const { client, setNext, labels } = await mount()
  let release!: (result: Result) => void
  setNext(() => new Promise(resolve => { release = resolve }))
  let refresh!: Promise<unknown>
  act(() => { refresh = client.refetchQueries({ queryKey: ['read'] }) })
  await waitFor(() => expect(screen.queryByRole('button', { name: labels.listIdentifierCopy })).toBeNull())
  expect(screen.queryByText(id)).toBeNull()
  await act(async () => { release({ data: [{ id, name }], next_cursor: null }); await refresh })
  await screen.findByRole('button', { name: labels.listIdentifierCopy })
  setNext(async () => { throw { status: 403 } })
  await act(async () => { await client.refetchQueries({ queryKey: ['read'] }) })
  await waitFor(() => expect(screen.queryByText(id)).toBeNull())
  expect(screen.queryByText(name)).toBeNull()
  expect(screen.queryByRole('button', { name: labels.listIdentifierCopy })).toBeNull()
})

it('retains explicit user hiding of ID when reusing the copy cell', async () => {
  const { labels } = await mount('en', name, true)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(name)
  expect(screen.queryByText(id)).toBeNull()
  expect(screen.queryByRole('button', { name: labels.listIdentifierCopy })).toBeNull()
})
