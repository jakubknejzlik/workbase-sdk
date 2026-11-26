import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
import { GeneratedActions, GeneratedRowActions } from '../../console-generated/src/write-screens'
import type { Model, Capabilities, Command } from '../../console-generated/src/read'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate, Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }))
afterEach(() => vi.clearAllMocks())
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const command = (name: string, replacement?: string): Command => ({ name: `entries/${name}`, permission: { entity: 'entries', operation: replacement ?? 'update' }, ui: { replacesCrud: replacement, label: { en: name, cs: `Česky ${name}` } }, inputSchema: { type: 'object', properties: { entry: { type: 'string', referenceEntity: 'entries' } }, required: ['entry'] } })
async function mount(options: { language?: 'en' | 'cs'; operations?: string[]; commands?: Command[]; rowMenu?: boolean; beforeMutation?: () => Promise<void> } = {}) {
  const language = options.language ?? 'en', labels = language === 'cs' ? cs : en
  const model: Model = { instance: 'detail-actions', revision: 1, limits: { root: 100, children: 10, relations: 10, exists: 100 }, entities: {
    entries: { displayField: 'name', fields: { id: { type: 'string' }, name: { type: 'string' }, version: { type: 'int' } }, columns: ['name'], writeSchema: { type: 'object', properties: { name: { type: 'string' } } }, relations: {}, routes: { list: '', detail: '' } },
  }, commands: options.commands ?? [] }
  let caps: Capabilities = { revision: 1, commands: model.commands!.map(command => command.name), entities: { entries: { operations: options.operations ?? ['read', 'update', 'delete'], readable: ['id', 'name', 'version'], writable: ['name'] } } }
  let readBlocked = false
  let row = { id: 'one/encoded', name: 'Žaneta Šťastná', version: 1 }
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: language, resources: { [language]: { translation: labels } } })
  const write = vi.fn(async (_path: string, _method: string, _body?: unknown) => ({}))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false, onMutate: options.beforeMutation } } })
  const request = vi.fn(async () => ({ data: [row], next_cursor: null }))
  const element = () => {
    const Action = options.rowMenu ? GeneratedRowActions : GeneratedActions
    return <I18nextProvider i18n={i18n}><QueryClientProvider client={client}><Action model={model} caps={caps} orgId="org" entity="entries" row={row} request={request} write={write} readBlocked={readBlocked} /></QueryClientProvider></I18nextProvider>
  }
  const view = render(element()), user = userEvent.setup()
  const trigger = () => screen.getByRole('button', { name: labels.rowActions.replace('{{name}}', row.name) })
  const choose = async (label = labels.delete) => { await user.click(trigger()); await user.click(screen.getByRole('menuitem', { name: label })) }
  return { ...view, user, write, labels, trigger, choose, record: (id: string) => { row = { ...row, id }; view.rerender(element()) }, grants: (operations: string[], commands: string[] = []) => { caps = { ...caps, revision: caps.revision + 1, commands, entities: { entries: { ...caps.entities.entries, operations } } }; view.rerender(element()) }, block: (blocked: boolean) => { readBlocked = blocked; view.rerender(element()) } }
}

it.each(['en', 'cs'] as const)('%s detail keeps Edit quiet and hands keyboard menu → confirmation → Cancel focus back to the connected menu trigger', async language => {
  const { user, labels, trigger, write } = await mount({ language })
  expect(screen.getAllByRole('button', { name: labels.edit })).toHaveLength(1)
  expect(screen.getByRole('button', { name: labels.edit }).className).not.toContain('bg-primary')
  expect(screen.queryByRole('button', { name: labels.delete })).toBeNull()
  const menuTrigger = trigger(); menuTrigger.focus()
  await user.keyboard('{Enter}')
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([labels.delete])
  await user.keyboard('{Enter}')
  const dialog = await screen.findByRole('alertdialog', { name: labels.deleteRecord })
  expect(dialog.textContent).toContain('Žaneta Šťastná')
  expect(dialog.textContent).toContain(labels.deleteDescription)
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: labels.cancel }))
  await user.keyboard('{Enter}')
  await waitFor(() => expect(document.activeElement).toBe(menuTrigger))
  expect(menuTrigger.isConnected).toBe(true)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(write).not.toHaveBeenCalled()
})

it('Delete keeps the exact authorized DELETE, pending dismissal guard and synchronous once-only submission', async () => {
  const { choose, user, write, labels } = await mount(), pending = deferred()
  write.mockImplementation(() => pending.promise.then(() => ({})))
  await choose()
  const dialog = screen.getByRole('alertdialog'), form = dialog.querySelector('form')!
  fireEvent.submit(form); fireEvent.submit(form)
  await waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith('/api/entries/one%2Fencoded', 'DELETE'))
  expect(within(dialog).getByRole('button', { name: labels.cancel })).toHaveProperty('disabled', true)
  await user.keyboard('{Escape}')
  expect(screen.getByRole('alertdialog')).toBe(dialog)
  await act(async () => pending.resolve())
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(write).toHaveBeenCalledTimes(1)
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/o/$orgId/e/$entity', params: { orgId: 'org', entity: 'entries' } })
})

it.each(['en', 'cs'] as const)('%s puts only delete replacements in the detail menu, retaining command confirmation/input/key and other commands once', async language => {
  const { choose, user, write, labels, trigger } = await mount({ language, operations: ['read'], commands: [command('Amend', 'update'), command('Remove', 'delete'), command('Notify')] })
  const name = language === 'cs' ? 'Česky Remove' : 'Remove'
  expect(screen.queryByRole('button', { name })).toBeNull()
  for (const label of ['Amend', 'Notify']) expect(screen.getAllByRole('button', { name: language === 'cs' ? `Česky ${label}` : label })).toHaveLength(1)
  await user.click(trigger())
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([name])
  expect(screen.getByRole('menuitem').getAttribute('data-variant')).toBe('destructive')
  await user.click(screen.getByRole('menuitem'))
  await user.click(within(screen.getByRole('dialog', { name })).getByRole('button', { name: labels.cancel }))
  await waitFor(() => expect(document.activeElement).toBe(trigger()))
  await choose(name)
  await user.click(within(screen.getByRole('dialog', { name })).getByRole('button', { name }))
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  expect(write.mock.calls[0]).toEqual(['/commands/entries/Remove', 'POST', { entry: 'one/encoded', idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) }])
})

it.each(['no destructive grants', 'read revoked', 'CRUD suppresses replacement'] as const)('renders no empty detail menu: %s', async state => {
  const { grants, labels } = await mount({ operations: ['read', 'update'], commands: state === 'CRUD suppresses replacement' ? [command('Amend', 'update')] : [] })
  if (state === 'read revoked') grants([])
  expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull()
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Amend' })).toBeNull()
  if (state !== 'read revoked') expect(screen.getAllByRole('button', { name: labels.edit })).toHaveLength(1)
})

it('CRUD delete suppresses its replacement instead of duplicating the operation', async () => {
  const { user, trigger, labels } = await mount({ commands: [command('Remove', 'delete')] })
  await user.click(trigger())
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([labels.delete])
})

it('read blocking keeps the return-focus trigger focusable and rejects stale confirmation', async () => {
  const { choose, block, trigger, write, labels, user } = await mount()
  block(true); trigger().focus(); expect(document.activeElement).toBe(trigger())
  block(false); await choose(); block(true)
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: labels.delete }))
  expect(write).not.toHaveBeenCalled()
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: labels.cancel }))
  await waitFor(() => expect(document.activeElement).toBe(trigger()))
  expect(trigger().isConnected).toBe(true)
})

it.each(['crud', 'command'] as const)('%s revocation removes an open confirmation and cannot submit a queued mutation with stale authority', async kind => {
  const queued = deferred()
  const { choose, grants, write, user, labels } = await mount({ operations: kind === 'crud' ? ['read', 'delete'] : ['read'], commands: kind === 'command' ? [command('Remove', 'delete')] : [], beforeMutation: () => queued.promise })
  await choose(kind === 'crud' ? labels.delete : 'Remove')
  const dialog = screen.getByRole(kind === 'crud' ? 'alertdialog' : 'dialog')
  await user.click(within(dialog).getByRole('button', { name: kind === 'crud' ? labels.delete : 'Remove' }))
  grants(['read'])
  expect(screen.queryByRole('alertdialog')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull()
  await act(async () => queued.resolve())
  expect(write).not.toHaveBeenCalled()
})

it('existing list row menu still includes Edit, ordinary commands and Delete once', async () => {
  const { user, trigger, labels } = await mount({ rowMenu: true, commands: [command('Notify')] })
  await user.click(trigger())
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([labels.edit, 'Notify', labels.delete])
})

it.each(['blocked read', 'unmount', 'changed record'] as const)('a queued destructive command cannot write after %s', async state => {
  const queued = deferred()
  const view = await mount({ operations: ['read'], commands: [command('Remove', 'delete')], beforeMutation: () => queued.promise })
  await view.choose('Remove')
  await view.user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
  if (state === 'unmount') view.unmount()
  else if (state === 'blocked read') view.block(true)
  else view.record('different')
  await act(async () => queued.resolve())
  expect(view.write).not.toHaveBeenCalled()
})
