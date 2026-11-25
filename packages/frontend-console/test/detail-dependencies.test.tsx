import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'
import { detailPlan } from '../../console-generated/src/detail-plan'
import { DetailGroups } from '../../console-generated/src/detail-groups'
import { DetailFields } from '../../ui/src/detail-page'
import { readQuery, type Model, type Capabilities, type ReadQuery } from '../../console-generated/src/read'
import { GeneratedReadPage } from '../../console-generated/src/screens'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}))

function fixture(placement: 'summary' | 'group' = 'group') {
  const conditional = { field: 'name', when: { field: 'user', eq: null } }
  const model: Model = { instance: 'dependencies', revision: 1, limits: { root: 100, children: 10, relations: 10, exists: 100 }, entities: {
    entries: { accountLink: { field: 'user', entity: 'accounts' }, displayField: 'title',
      fields: { id: { type: 'string' }, title: { type: 'string' }, name: { type: 'string' }, user: { type: 'ref', entity: 'accounts' } }, columns: ['name', 'user'],
      detail: { summary: placement === 'summary' ? ['user', conditional] : ['user'], groups: [{ id: 'main', label: 'Information', fields: placement === 'group' ? ['user', conditional] : ['user'] }] },
      relations: {}, routes: { list: '', detail: '' } },
    accounts: { fields: { id: { type: 'string' } }, columns: ['id'], relations: {}, routes: { list: '', detail: '' } },
  } }
  const caps: Capabilities = { revision: 1, entities: Object.fromEntries(Object.entries(model.entities).map(([name, entity]) => [name, { operations: ['read'], readable: Object.keys(entity.fields), writable: [] }])) }
  return { model, caps }
}

it.each(['summary', 'group'] as const)('planner preserves an authorized link operand without presenting it in %s', placement => {
  const { model, caps } = fixture(placement)
  const plan = detailPlan(model, 'entries', caps)!
  expect(plan.select).toEqual(['id', 'title', 'name', 'user'])
  expect([...plan.summary, ...plan.groups.flatMap(group => group.fields)]).toEqual([{ field: 'name', when: { field: 'user', eq: null } }])
  expect(plan.labels).not.toContain('user')
  const query = readQuery(model, 'entries', caps, { id: 'entry' })
  expect(query.select).toEqual(plan.select)
  expect(query.labels ?? []).not.toContain('user')
})

it.each(['field', 'target read', 'target id'] as const)('denied %s gate excludes the link operand and dependent item', denied => {
  const { model, caps } = fixture()
  if (denied === 'field') caps.entities.entries.readable = ['id', 'title', 'name']
  if (denied === 'target read') caps.entities.accounts.operations = []
  if (denied === 'target id') caps.entities.accounts.readable = []
  const plan = detailPlan(model, 'entries', caps)!
  expect(plan.select).toEqual(['id', 'title'])
  expect(plan.summary).toEqual([])
  expect(plan.groups).toEqual([])
  expect(readQuery(model, 'entries', caps, { id: 'entry' }).select).toEqual(['id', 'title'])
})

it.each([
  { placement: 'summary', user: null, state: 'provided', content: 'Conditional name' },
  { placement: 'summary', user: 'account', state: 'not-applicable', content: en.detailNotApplicable },
  { placement: 'group', user: null, state: 'provided', content: 'Conditional name' },
  { placement: 'group', user: 'account', state: 'not-applicable', content: en.detailNotApplicable },
] as const)('detail evaluates the hidden $placement link operand for user=$user', async ({ placement, user, state, content }) => {
  const { model, caps } = fixture(placement)
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: { ...en, field_user: 'Raw User', field_name: 'Name' } } } })
  const row: Record<string, unknown> = { id: 'entry', title: 'Entry title', name: 'Conditional name', user }
  // Honor the actual query projection so an omitted null operand remains undefined.
  const request = vi.fn(async (query: ReadQuery) => ({ data: [Object.fromEntries(query.select.map(field => [field, row[field]]))], next_cursor: null }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" id="entry" request={request} /></QueryClientProvider></I18nextProvider>)
  await screen.findByRole('heading', { name: 'Entry title' })
  const item = container.querySelector('[data-detail-field="name"]')!
  expect(item.getAttribute('data-detail-state')).toBe(state)
  expect(within(item as HTMLElement).getByText(content)).toBeTruthy()
  expect(request.mock.calls[0][0].select).toContain('user')
  expect(container.querySelector('[data-detail-field="user"]')).toBeNull()
  expect(screen.queryByText('Raw User')).toBeNull()
  expect(screen.queryByText('account')).toBeNull()
  expect(screen.queryByText('Application access')).toBeNull()
})

it.each(['en', 'cs'] as const)('summary/groups retain %s states, reference content, help and applicable edit slots', locale => {
  const { model, caps } = fixture()
  const plan = detailPlan(model, 'entries', caps)!
  plan.summary = [{ field: 'title', label: 'Full name', help: 'Name help' }]
  plan.groups = [{ id: 'main', label: 'Information', help: 'Group help', fields: [
    { field: 'name', when: { field: 'user', eq: null }, help: 'Field help' },
    { field: 'reference' }, { field: 'empty' },
  ] }]
  const labels = locale === 'en' ? en : cs
  const translate = (key: string) => key === 'detailNotApplicable' ? labels.detailNotApplicable : key === 'detailNotProvided' ? labels.detailNotProvided : key
  const edit = vi.fn((_field: string, content: ReactNode) => <span data-edit-slot="">{content}</span>)
  const value = vi.fn((field: string) => field === 'reference' ? <a href="/related/authorized">Authorized reference</a> : 'Žaneta Šťastná')
  const { container, rerender } = render(<DetailGroups plan={plan} row={{ title: 'Žaneta', name: 'Hidden content', user: 'linked', __labels: { reference: { status: 'unavailable' } } }} label={field => field} value={value} translate={translate} edit={edit} />)
  const summary = container.querySelector('[data-detail-summary]')!
  expect(within(summary as HTMLElement).getByText('Full name').tagName).toBe('DT')
  expect(within(summary as HTMLElement).getByText('Name help').closest('dd')).toBeTruthy()
  const conditional = container.querySelector('[data-detail-field="name"]')!
  expect(conditional.getAttribute('data-detail-state')).toBe('not-applicable')
  expect(within(conditional as HTMLElement).getByText(labels.detailNotApplicable)).toBeTruthy()
  expect(within(conditional as HTMLElement).getByText('Field help').closest('dd')).toBeTruthy()
  expect(conditional.querySelector('[data-edit-slot]')).toBeNull()
  expect(value).not.toHaveBeenCalledWith('name')
  expect(value).not.toHaveBeenCalledWith('empty')
  expect(container.querySelector('[data-detail-field="empty"]')?.textContent).toContain(labels.detailNotProvided)
  expect(screen.getByRole('link', { name: 'Authorized reference' }).getAttribute('href')).toBe('/related/authorized')
  expect(screen.getByRole('heading', { name: 'Information' })).toBeTruthy()
  expect(screen.getByText('Group help')).toBeTruthy()
  // No second grid/renderer or hidden condition row is created by the styling.
  expect(container.querySelector('[data-detail-field="user"]')).toBeNull()
  expect(container.querySelector('[data-detail-summary] [data-detail-grid="summary"]')).toBeTruthy()
  expect(container.querySelector('[data-detail-group] [data-detail-grid="metadata"]')).toBeTruthy()
  rerender(<DetailGroups plan={plan} row={{ title: 'Žaneta', name: null, user: null }} label={field => field} value={value} translate={translate} edit={edit} />)
  expect(container.querySelector('[data-detail-field="name"]')?.getAttribute('data-detail-state')).toBe('not-provided')
  expect(container.querySelector('[data-detail-field="name"] [data-edit-slot]')?.textContent).toContain(labels.detailNotProvided)
  expect(edit.mock.calls.some(([field]) => field === 'name')).toBe(true)
})

it('fallback fields preserve values and links in the shared metadata hierarchy', () => {
  const { container } = render(<DetailFields fields={[{ name: 'name', label: 'Jméno', value: 'Žaneta Šťastná' }, { name: 'parent', label: 'Přiřazený záznam', value: <a href="/related/record">Related record</a> }]} />)
  expect(container.querySelectorAll('dl[data-detail-grid="metadata"] > [data-detail-field]')).toHaveLength(2)
  expect(container.querySelector('dt')?.textContent).toBe('Jméno')
  expect(container.querySelector('dd')?.textContent).toBe('Žaneta Šťastná')
  expect(screen.getByRole('link', { name: 'Related record' }).getAttribute('href')).toBe('/related/record')
})

it('permission-reduced generated detail renders neither a denied operand nor its dependent field', async () => {
  const { model, caps } = fixture()
  caps.entities.entries.readable = ['id', 'title', 'name']
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
  const request = vi.fn(async (query: ReadQuery) => ({ data: [Object.fromEntries(query.select.map(field => [field, field === 'title' ? 'Reduced entry' : 'entry']))], next_cursor: null }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><GeneratedReadPage model={model} caps={caps} orgId="org" entity="entries" id="entry" request={request} /></QueryClientProvider></I18nextProvider>)
  await screen.findByRole('heading', { name: 'Reduced entry' })
  expect(request.mock.calls[0][0].select).toEqual(['id', 'title'])
  expect(container.querySelector('[data-detail-field="user"]')).toBeNull()
  expect(container.querySelector('[data-detail-field="name"]')).toBeNull()
})
