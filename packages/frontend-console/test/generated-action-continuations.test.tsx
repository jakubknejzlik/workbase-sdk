import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import { afterEach, expect, it, vi } from 'vitest'
import { GeneratedCreateDialog } from '@workbasehq/console-generated/writes'
import { GeneratedActionProvider } from '../../console-generated/src/action-context'
import type { Model, Capabilities } from '@workbasehq/console-generated/read'
import { discardAuthority, runAuthorityAction } from '../src/api/authority'
import en from '../src/locales/en.json'
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
afterEach(() => vi.restoreAllMocks())
it.each([false, true])('delegated entity create cannot close after retirement during refresh; retired=%s', async retire => {
  const client = new QueryClient()
  const model = { instance: 'generated', revision: 1, entities: { entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' } }, columns: ['name'], writeSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, relations: {}, routes: {} } }, commands: [], workflows: [], limits: { root: 100, children: 10, relations: 10, exists: 100 } } as unknown as Model
  const caps: Capabilities = { revision: 1, entities: { entries: { operations: ['read', 'create'], readable: ['id', 'name'], writable: ['name'] } }, commands: [] }
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, entitySingular_entries: 'Entry', field_name: 'Name' } } } })
  let release = () => {}; const waiting = new Promise<void>(resolve => { release = resolve })
  const refresh = vi.spyOn(client, 'invalidateQueries').mockReturnValue(waiting)
  const close = vi.fn(), write = vi.fn(async () => ({ id: 'created', name: 'Fresh' }))
  const view = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><GeneratedActionProvider run={action => runAuthorityAction(client, 'A', action)}><GeneratedCreateDialog model={model} caps={caps} orgId="A" entity="entries" request={async () => ({ data: [], next_cursor: null })} write={write} open onOpenChange={close} /></GeneratedActionProvider></QueryClientProvider></I18nextProvider>)
  fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Fresh' } })
  fireEvent.submit(screen.getByRole('textbox', { name: 'Name' }).closest('form')!)
  await waitFor(() => expect(refresh).toHaveBeenCalled())
  await act(async () => { if (retire) discardAuthority(client, 'A'); release(); await waiting })
  await waitFor(() => retire ? expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(false) : expect(close).toHaveBeenCalledWith(false))
  if (retire) expect(close).not.toHaveBeenCalled()
  expect(write).toHaveBeenCalledTimes(1)
  view.unmount(); client.clear()
})
