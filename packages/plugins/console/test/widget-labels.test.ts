import { beforeEach, expect, it } from 'vitest'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { createApp } from '@workbasehq/core/app'
import type { ConsoleModelContract, ConsolePage, ConsolePageResult, ConsoleWidget } from '@workbasehq/core/console-contract'
import type { InstanceConfig } from '@workbasehq/core/config'
import sample from '../../../core/test/fixtures/sample/config'
import { request, runtime, setup } from '@workbasehq/test-support/helpers'

const labels = {
  en: { dashboard_count: 'Client count', dashboard_table: 'Recent clients', dashboard_list: 'Client names', dashboard_private: 'Private caption', dashboard_unused: 'Unused caption', entity_clients: 'Clients' },
  cs: { dashboard_count: 'Počet zákazníků', dashboard_table: 'Nejnovější zákazníci', dashboard_list: 'Jména zákazníků', dashboard_private: 'Soukromý popisek', dashboard_unused: 'Nepoužitý popisek', entity_clients: 'Zákazníci' },
}
const widgets: ConsoleWidget[] = [
  { id: 'count', kind: 'stat', label: 'dashboard_count', query: { entity: 'clients' }, aggregate: { fn: 'count' } },
  { id: 'table', kind: 'table', label: 'dashboard_table', query: { entity: 'clients', select: ['id', 'name'], limit: 5 }, columns: ['name'] },
  { id: 'list', kind: 'list', label: 'dashboard_list', query: { entity: 'clients', select: ['id', 'name'], limit: 5 }, field: 'name' },
  { id: 'fallback', kind: 'stat', label: 'entity_clients', query: { entity: 'clients' }, aggregate: { fn: 'count' } },
]
function config(enumLabels: InstanceConfig['enumLabels'] = labels, items = widgets): InstanceConfig {
  const pages: ConsolePage[] = [
    { id: 'labels', path: '/labels', label: 'overview', widgets: items },
    { id: 'private-labels', path: '/private-labels', label: 'overview', grant: 'organizations.update', widgets: [{ ...widgets[0], label: 'dashboard_private' }] },
  ]
  return { ...sample, enumLabels, plugins: [...sample.plugins!, { name: 'widget-labels', version: '1', requires: { console: '^1' }, contributes: { console: { pages } } }] }
}
beforeEach(async () => { await setup() })

it.each(widgets)('accepts the declared or entity fallback label for $kind/$id', widget => {
  expect(() => new KernelRegistry(config(labels, [widget]))).not.toThrow()
})

it.each(['en', 'cs'] as const)('rejects a caption missing from %s with the key and widget location', language => {
  const incomplete = structuredClone(labels)
  delete (incomplete[language] as Record<string, string>).dashboard_count
  expect(() => new KernelRegistry(config(incomplete))).toThrow(`Unknown console widget label key: labels.count: dashboard_count (declare a nonempty config.enumLabels.${language} entry)`)
})

it.each(['missing_key', 'Free form caption', 'entity_missing'])('rejects undeclared label %s', label => {
  expect(() => new KernelRegistry(config(labels, [{ ...widgets[0], label }]))).toThrow(`Unknown console widget label key: labels.count: ${label}`)
})

it.each(['', '   '])('rejects blank declared captions (%j)', caption => {
  expect(() => new KernelRegistry(config({ ...labels, cs: { ...labels.cs, dashboard_count: caption } }))).toThrow('config.enumLabels.cs')
})

it('keeps entity fallback valid without an instance dictionary', () => {
  const input = config({}, [widgets[3]])
  input.plugins = input.plugins!.map(plugin => plugin.name === 'widget-labels' ? { ...plugin, contributes: { console: { pages: [{ id: 'labels', path: '/labels', label: 'overview', widgets: [widgets[3]] }] } } } : plugin)
  delete input.enumLabels
  expect(() => new KernelRegistry(input)).not.toThrow()
})

it('projects captions in both locales only for authorized widgets and preserves response label keys', async () => {
  const app = createApp(config(), runtime())
  const response = await request(app, '/o/org-a/console-model', 'GET', undefined, 'viewer-a')
  expect(response.status).toBe(200)
  const body = await response.json() as ConsoleModelContract
  for (const language of ['en', 'cs'] as const) {
    const { dashboard_private: _private, dashboard_unused: _unused, ...expected } = labels[language]
    expect(body.model.enumLabels?.[language]).toMatchObject(expected)
    expect(body.model.enumLabels?.[language]).not.toHaveProperty('dashboard_private')
    expect(body.model.enumLabels?.[language]).not.toHaveProperty('dashboard_unused')
  }
  expect(body.console?.pages.find(page => page.id === 'labels')?.widgets?.map(widget => widget.label)).toEqual(widgets.map(widget => widget.label))
  const result = await request(app, '/o/org-a/console-pages/labels', 'GET', undefined, 'viewer-a')
  expect(result.status).toBe(200)
  expect((await result.json() as ConsolePageResult).widgets.map(widget => widget.label)).toEqual(widgets.map(widget => widget.label))
  const owner = await request(app, '/o/org-a/console-model')
  expect((await owner.json() as ConsoleModelContract).model.enumLabels?.cs).toHaveProperty('dashboard_private', labels.cs.dashboard_private)
})

it('omits captions whose widget filter consumes a denied field', async () => {
  const input = config(labels, [...widgets, { id: 'filtered', kind: 'stat', aggregate: { fn: 'count' }, label: 'dashboard_private', query: { entity: 'clients', where: { email: { eq: 'alex@example.test' } } } }])
  input.plugins = [...input.plugins!, { name: 'mask-email', version: '1', fieldMask: () => ['id', 'name'] }]
  const response = await request(createApp(input, runtime()), '/o/org-a/console-model', 'GET', undefined, 'viewer-a')
  expect(response.status).toBe(200)
  const body = await response.json() as ConsoleModelContract
  expect(body.console?.pages.find(page => page.id === 'labels')?.widgets?.map(widget => widget.id)).toEqual(widgets.map(widget => widget.id))
  for (const language of ['en', 'cs']) expect(body.model.enumLabels?.[language]).not.toHaveProperty('dashboard_private')
})
