import { neutralConfig } from './config'
import type { ConsolePage } from '../../../core/src/console-contract'
import { defineCommand } from '@workbasehq/core'
import { z } from 'zod'

// Synthetic four-column booking case from #304; ordinary SDK schema and widgets only.
export const widgetTableConfig = neutralConfig()
Object.assign(widgetTableConfig.entities.specimens.fields, {
  client: { type: 'ref', entity: 'clients' }, location: { type: 'ref', entity: 'locations' },
  status: { type: 'string' },
})
for (const entity of ['clients', 'locations']) {
  widgetTableConfig.entities[entity] = { displayField: 'name', fields: { name: { type: 'string', required: true } }, relations: {}, checks: [] }
  widgetTableConfig.permissions!.owner[entity] = ['read']
  widgetTableConfig.policies![entity] = { owner: 'all' }
}
widgetTableConfig.policies!.specimens.owner = 'all'
widgetTableConfig.ui!.entities!.specimens.list = { columns: ['client', 'location', 'status', 'updated_at'].map(field => ({ field })) }
const dashboard = widgetTableConfig.plugins!.find(plugin => plugin.name === 'neutral-dashboard')!
const pages: ConsolePage[] = dashboard.contributes!.console!.pages = [{ id: 'neutral.summary', path: '/summary', label: 'Synthetic bookings',
  sections: [{ row: ['bookings', 'clients'] }, { row: ['count'] }], widgets: [
    { id: 'count', label: 'dashboard_specimen_count', kind: 'stat', query: { entity: 'specimens' }, aggregate: { fn: 'count' } },
    { id: 'bookings', label: 'dashboard_attention', kind: 'table', query: { entity: 'specimens', select: ['id', 'client', 'location', 'status', 'updated_at'], labels: ['client', 'location'], limit: 5 }, columns: ['client', 'location', 'status', 'updated_at'] },
    { id: 'clients', label: 'dashboard_clients', kind: 'list', query: { entity: 'specimens', select: ['id', 'client'], labels: ['client'], limit: 5 }, field: 'client' },
  ],
}]

// Existing sections alone prioritize attention; array order remains the legacy fallback.
pages.push({ ...pages[0], id: 'neutral.default', path: '/default', sections: undefined })
pages.push({ ...pages[0], id: 'neutral.isolated', path: '/isolated', sections: [{ row: ['bookings', 'clients'] }, { row: ['count', 'unavailable'] }], widgets: [
  ...pages[0].widgets!,
  { id: 'unavailable', label: 'Unavailable records', kind: 'table', columns: ['id'], query: { entity: 'specimens', select: ['id'], limit: 5, contextList: { entity: 'specimens', list: 'missing', id: 'booking-0' } } },
] })
Object.assign(widgetTableConfig.enumLabels!.en, {
  dashboard_attention: 'Bookings that need attention and confirmation from the team',
  dashboard_clients: 'Clients associated with the current bookings',
})
Object.assign(widgetTableConfig.enumLabels!.cs, {
  dashboard_attention: 'Rezervace vyžadující pozornost a potvrzení odpovědným pracovníkem',
  dashboard_clients: 'Klienti přiřazení k aktuálně zobrazeným rezervacím',
})

// E3 uses the same real Worker/D1 fixture as E1; no mocked form or mutation host.
const register = defineCommand({ name: 'clients/register', permission: { entity: 'clients', operation: 'update' },
  ui: { placement: { entity: 'clients', action: 'create' }, label: { en: 'Register client', cs: 'Zaregistrovat klienta' } }, input: z.object({ name: z.string().min(1) }),
  plan: (context, { name }) => ({ rules: [{ name: 'register', statements: [{ sql: 'INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)', bindings: [context.newId, context.scope.organizationId, name, context.now, context.now], expectRows: 1 }] }], result: { status: 200, body: { name } }, event: { entity: 'clients', entityId: context.newId, operation: 'client.registered' } }),
})
const process = defineCommand({ name: 'specimens/process', permission: { entity: 'specimens', operation: 'update' },
  ui: { label: { en: 'Process specimens', cs: 'Zpracovat vzorky' } }, input: z.object({ name: z.string().min(1) }),
  plan: (context, { name }) => ({ rules: [{ name: 'process', statements: [{ sql: 'UPDATE specimens SET quantity=quantity+1,version=version+1 WHERE organization_id=? AND id=?', bindings: [context.scope.organizationId, name === 'fail' ? 'missing' : 'booking-0'], expectRows: 1 }] }], result: { status: 200, body: { name } }, event: { entity: 'specimens', entityId: 'booking-0', operation: 'specimen.processed' } }),
})
dashboard.commands = [...dashboard.commands ?? [], register, process]
widgetTableConfig.permissions!.owner.clients = ['read', 'update']
const actions: NonNullable<ConsolePage['actions']> = [
  { id: 'create', label: 'action_create', description: 'action_create_description', icon: 'Wallet', primary: true, target: { create: 'specimens' } },
  { id: 'register', label: 'action_register', description: 'action_register_description', icon: 'Users', target: { create: 'clients' } },
  { id: 'process', label: 'action_process', description: 'action_process_description', icon: 'Activity', target: { command: process.name } },
  { id: 'navigate', label: 'action_navigate', description: 'action_navigate_description', icon: 'Database', target: { navigation: 'entity.specimens' } },
]
for (const state of ['zero', 'one', 'multiple', 'long', 'denied']) pages.push({ ...pages[0], id: `neutral.actions-${state}`, path: `/actions-${state}`,
  actions: state === 'zero' ? [] : state === 'one' ? actions.slice(0, 1) : state === 'denied' ? [{ id: 'denied', label: 'action_denied', primary: true, target: { create: 'locations' } }]
    : state === 'long' ? actions.map(action => ({ ...action, label: action.label + '_long' })) : actions,
})
Object.assign(widgetTableConfig.enumLabels!.en, {
  action_create: 'Create specimen', action_create_description: 'Add a specimen using the existing form.',
  action_register: 'Register client', action_register_description: 'Register through the configured create command.',
  action_process: 'Process specimens', action_process_description: 'Run the existing collection operation.',
  action_navigate: 'Browse specimens', action_navigate_description: 'Open the current workspace collection.',
  action_create_long: 'Create a specimen with a deliberately long action title', action_register_long: 'Register a client through the configured collection command',
  action_process_long: 'Process the available specimens using the existing form', action_navigate_long: 'Browse specimens in the current authorized workspace', action_denied: 'Unavailable create action',
})
Object.assign(widgetTableConfig.enumLabels!.cs, {
  action_create: 'Vytvořit vzorek', action_create_description: 'Přidat vzorek pomocí existujícího formuláře.',
  action_register: 'Zaregistrovat klienta', action_register_description: 'Založit klienta připraveným příkazem pro vytvoření.',
  action_process: 'Zpracovat vzorky', action_process_description: 'Spustit existující operaci nad kolekcí.',
  action_navigate: 'Procházet vzorky', action_navigate_description: 'Otevřít kolekci aktuálního pracovního prostoru.',
  action_create_long: 'Vytvořit vzorek s úmyslně velmi dlouhým popiskem dostupné akce', action_register_long: 'Zaregistrovat klienta prostřednictvím připraveného příkazu kolekce',
  action_process_long: 'Zpracovat dostupné vzorky pomocí existujícího formuláře', action_navigate_long: 'Procházet vzorky v aktuálním oprávněném pracovním prostoru', action_denied: 'Nedostupné vytvoření',
})
