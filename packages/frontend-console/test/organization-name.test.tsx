import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { createInstance } from 'i18next'
import { organizationNameCases } from '../../test-support/src/organization-name-cases'
import { MutationSession } from '@workbasehq/ui'
import { CreateOrganizationForm } from '../src/create-organization-dialog'
import { OrganizationSettings } from '../src/settings'
import en from '../src/locales/en.json'
import cs from '../src/locales/cs.json'

vi.mock('@tanstack/react-router', async importOriginal => ({ ...await importOriginal<object>(), useNavigate: () => vi.fn() }))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

async function mount(surface: 'create' | 'settings', language: 'en' | 'cs', serverReason?: string) {
  const labels = language === 'cs' ? cs : en
  const i18n = createInstance()
  await i18n.init({ lng: language, resources: { [language]: { translation: labels } }, interpolation: { escapeValue: false } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(client)
  let stored = 'Original'
  const writes = vi.fn(async (_url: string, init: RequestInit) => {
    if (serverReason) return Response.json({ error: 'invalid_organization_name', detail: { field: 'name', reason: serverReason } }, { status: 400 })
    stored = JSON.parse(init.body as string).name
    return Response.json({ id: 'org', name: stored, invalidates: [] })
  })
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') return writes(url, init)
    if (url === '/me?scope=organization') return Response.json({ user: { id: 'owner' }, memberships: [{ organization_id: 'org', name: stored, role: 'owner' }] })
    if (url === '/o/org/capabilities') return Response.json({ resources: { 'organizations.update': true } })
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}>
    {surface === 'create' ? <MutationSession close={() => {}} cancelLabel={labels.cancel}>{() => <CreateOrganizationForm retainActive />}</MutationSession> : <OrganizationSettings orgId="org" />}
  </QueryClientProvider></I18nextProvider>)
  const input = await screen.findByLabelText(labels.organizationName)
  const submit = () => fireEvent.click(screen.getByRole('button', { name: surface === 'create' ? labels.create : labels.saveChanges }))
  const change = (value: string) => {
    // Supply the exact corpus to RHF, including LF/CR that native text inputs strip.
    Object.defineProperty(input, 'value', { configurable: true, get: () => value, set: () => {} })
    fireEvent.change(input)
  }
  return { labels, input, change, submit, writes, stored: () => stored }
}

for (const surface of ['create', 'settings'] as const) {
  for (const language of ['en', 'cs'] as const) {
    it.each(organizationNameCases)(`${surface} ${language}: $label`, async c => {
      const form = await mount(surface, language)
      form.change(c.input); form.submit()
      if (c.reason) {
        const message = form.labels[`organizationName_${c.reason}` as keyof typeof form.labels]
        expect(message).toBeTruthy()
        const error = await screen.findByText(message)
        expect(form.input.getAttribute('aria-invalid')).toBe('true')
        expect(form.input.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)
        expect(form.writes).not.toHaveBeenCalled()
        expect(form.stored()).toBe('Original')
      } else {
        await waitFor(() => expect(form.writes).toHaveBeenCalledTimes(1))
        expect(JSON.parse(form.writes.mock.calls[0][1].body as string)).toEqual({ name: c.value })
        expect(form.stored()).toBe(c.value)
      }
    })
    const reasons = [...new Set(organizationNameCases.flatMap(c => c.reason ? [c.reason] : []))]
    it.each(reasons)(`${surface} ${language}: maps server 400 %s to name`, async reason => {
      const form = await mount(surface, language, reason)
      form.change('Valid label'); form.submit()
      await waitFor(() => expect(form.writes).toHaveBeenCalledTimes(1))
      const message = form.labels[`organizationName_${reason}` as keyof typeof form.labels]
      const error = await screen.findByText(message)
      expect(form.input.getAttribute('aria-invalid')).toBe('true')
      expect(form.input.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)
      expect(form.stored()).toBe('Original')
    })
  }
}
