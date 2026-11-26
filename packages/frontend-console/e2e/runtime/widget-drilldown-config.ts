import type { ConsolePage } from '../../../core/src/console-contract'
import { widgetTableConfig } from './widget-table-config'

// One configured-home fixture: ordinary booking fields, supported widgets and E3 actions.
export const widgetDrilldownConfig = widgetTableConfig
const pending = { status: { eq: 'Pending confirmation' } }
const absent = { status: { eq: 'Absent' } }
widgetDrilldownConfig.ui!.entities!.specimens.list = {
  columns: ['name', 'client', 'location', 'status'].map(field => ({ field })), pageSize: 10,
  views: [{ id: 'attention', label: 'Pending confirmation', where: pending }, { id: 'empty', label: 'Empty bookings', where: absent }, { id: 'all', label: 'All bookings', where: {} }],
}
const dashboard = widgetDrilldownConfig.plugins!.find(plugin => plugin.name === 'neutral-dashboard')!
const actions = dashboard.contributes!.console!.pages!.find(page => page.id === 'neutral.actions-multiple')!.actions
export const home: ConsolePage = { id: 'neutral.home', path: '/', label: 'overview', actions,
  sections: [{ row: ['attention', 'count'] }, { row: ['names', 'zero', 'empty'] }, { row: ['missing', 'unsupported', 'names-without-id'] }], widgets: [
    { id: 'attention', label: 'dashboard_attention', kind: 'table', query: { entity: 'specimens', where: pending, select: ['id', 'name', 'client', 'location', 'status'], labels: ['client', 'location'], orderBy: [{ field: 'id', dir: 'asc' }], limit: 5 }, columns: ['name', 'client', 'location', 'status'], drilldown: { view: 'attention' } },
    { id: 'count', label: 'dashboard_pending', kind: 'stat', query: { entity: 'specimens', where: pending }, aggregate: { fn: 'count' }, drilldown: { view: 'attention' } },
    { id: 'names', label: 'dashboard_names', kind: 'list', query: { entity: 'specimens', where: pending, select: ['id', 'name'], orderBy: [{ field: 'id', dir: 'asc' }], limit: 5 }, field: 'name', drilldown: { view: 'attention' } },
    { id: 'zero', label: 'dashboard_zero', kind: 'stat', query: { entity: 'specimens', where: absent }, aggregate: { fn: 'count' }, drilldown: { view: 'empty' } },
    { id: 'empty', label: 'dashboard_empty', kind: 'list', query: { entity: 'specimens', where: absent, select: ['id', 'name'], limit: 5 }, field: 'name', drilldown: { view: 'empty' } },
    { id: 'missing', label: 'dashboard_missing', kind: 'stat', query: { entity: 'specimens', where: absent }, aggregate: { fn: 'sum', field: 'quantity' }, drilldown: { view: 'empty' } },
    { id: 'names-without-id', label: 'Names without identity', kind: 'list', query: { entity: 'specimens', select: ['name'], limit: 5 }, field: 'name' },
    { id: 'unsupported', label: 'dashboard_unsupported', kind: 'stat', query: { entity: 'specimens' }, aggregate: { fn: 'count' } },
  ],
}
dashboard.contributes!.console!.pages = [home]
// The configured home replaces Overview; keep the existing built-in navigation item.
dashboard.contributes!.console!.navigation = []
Object.assign(widgetDrilldownConfig.enumLabels!.en, { dashboard_pending: 'Bookings awaiting confirmation', dashboard_names: 'Names of bookings awaiting confirmation', dashboard_zero: 'Bookings with no matches', dashboard_empty: 'Empty booking list', dashboard_missing: 'Quantity for an empty selection', dashboard_unsupported: 'All bookings without a matching target' })
Object.assign(widgetDrilldownConfig.enumLabels!.cs, { dashboard_pending: 'Rezervace čekající na potvrzení', dashboard_names: 'Názvy rezervací čekajících na potvrzení', dashboard_zero: 'Rezervace bez odpovídajících záznamů', dashboard_empty: 'Prázdný seznam rezervací', dashboard_missing: 'Množství pro prázdný výběr', dashboard_unsupported: 'Všechny rezervace bez odpovídajícího cíle' })
