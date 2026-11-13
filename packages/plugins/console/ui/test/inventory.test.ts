// @vitest-environment jsdom
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement as h } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ConsoleProvider, LanguageSwitcher, PageView, renderNode } from '../src/react'
import { createClient, type ClientRequestInit } from '../src/client'
import { createI18n, type Catalogs, type Translate } from '../src/i18n'
import type { Manifest } from '../src/check'
import list from '../fixture/ui/workers/index'
import create from '../fixture/ui/workers/new'
import detail from '../fixture/ui/workers/$workerId/index'
import edit from '../fixture/ui/workers/$workerId/edit'
const root = resolve('packages/plugins/console/ui/fixture')
// Extraction stays in Node/Bun; the actual page render and interaction run in a DOM.
const extracted = spawnSync('bun', ['-e', `import { extractManifest } from './packages/plugins/console/ui/src/vite'; import { requiredKeys } from './packages/plugins/console/ui/src/validate'; import { checkSources } from './packages/plugins/console/ui/src/sources'; import { scanTSX } from './packages/plugins/console/ui/src/scan'; import { sdkCatalogs } from './packages/plugins/console/ui/src/catalogs'; import { loadConfig } from '@workbasehq/core/schema/load'; const root = ${JSON.stringify(root)}; const manifest = await extractManifest(root), loaded = await loadConfig(root + '/config.ts'), sources = checkSources(root); console.log(JSON.stringify({ manifest, required: [...requiredKeys(loaded.config, manifest, scanTSX(sources.modules, manifest.keys), sdkCatalogs.en).keys()] }))`], { encoding: 'utf8' })
if (extracted.status !== 0) throw new Error(extracted.stderr)
const { manifest, required } = JSON.parse(extracted.stdout) as { manifest: Manifest; required: string[] }
const catalogs: Catalogs = Object.fromEntries(['cs', 'en'].map(lang => [lang, Object.fromEntries(['ui', 'domain'].map(ns => [ns, JSON.parse(readFileSync(resolve(root, 'locales', lang, ns + '.json'), 'utf8'))]))]))
const identity = { actorId: 'a', orgId: 'o' }, row = { id: 'x', version: 1, name: 'Eva', status: 'active', locked: 'fixed', user: null }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
test.each(['cs', 'en'])('inventory drift: every fixture route and renderer state consumes exactly requiredKeys (%s)', async language => {
  const runtime = createI18n({ languages: ['cs', 'en'], profile: { language }, catalogs }), consumed = new Set<string>()
  const translate: Translate = (key, variables) => {
    expect(required).toContain(key); consumed.add(key)
    const text = runtime.t(key, variables); if (text.startsWith('⟦')) throw new Error('Missing: ' + key)
    return text
  }
  const slots = { fieldValue: { contexts: ['record' as const], props: { value: { kind: 'field' as const, type: 'userLink' } }, component: () => null } }
  function mount(mode: 'list' | 'detail' | 'create' | 'edit', fetch: (url: string, init: ClientRequestInit) => Promise<Response>) {
    cleanup()
    const route = manifest.routes.find(r => r.mode === mode)!, definition = { list, create, detail, edit }[mode]
    return render(h(ConsoleProvider, { identity, t: translate, fetch, slots }, h('nav', null, ...manifest.nav.map(item => h('span', { key: item.title }, translate('ui:' + item.title)))), h(PageView, { definition, route, routes: manifest.routes, entities: manifest.entities, params: { workerId: 'x' }, search: {}, navigate: () => {} })))
  }
  for (const mode of ['list', 'detail', 'create', 'edit'] as const) {
    mount(mode, async () => json(mode === 'list' ? { data: [row], next_cursor: 'more' } : row))
    if (mode === 'edit') await screen.findByLabelText(runtime.t('domain:field.worker.name'))
    else if (mode !== 'create') await screen.findAllByText('Eva')
  }
  for (const status of [404, 403, 500]) { mount('detail', async () => json({}, status)); await screen.findByRole('alert') }
  mount('list', async () => json({ data: [], next_cursor: null })); await screen.findByRole('alert')
  mount('create', async () => json({ issues: [{ path: ['name'], code: 'custom' }] }, 400))
  fireEvent.change(screen.getByLabelText(runtime.t('domain:field.worker.name')), { target: { value: 'Eva' } })
  fireEvent.click(screen.getByText(runtime.t('sdk:save'))); await screen.findAllByText(runtime.t('sdk:validation'))
  // Blank required input, dirty cancellation, conflict/reload cover non-happy-path copy.
  mount('create', async () => json(row))
  fireEvent.change(screen.getByLabelText(runtime.t('domain:field.worker.name')), { target: { value: ' ' } })
  fireEvent.click(screen.getByText(runtime.t('sdk:save'))); await screen.findByText(runtime.t('sdk:required'))
  vi.spyOn(globalThis as typeof globalThis & { confirm(message: string): boolean }, 'confirm').mockReturnValue(false)
  fireEvent.click(screen.getByText(runtime.t('sdk:cancel')))
  mount('edit', async (_url, init) => init.method === 'PATCH' ? json({ error: 'version_conflict' }, 409) : json(row))
  fireEvent.change(await screen.findByLabelText(runtime.t('domain:field.worker.name')), { target: { value: 'Changed' } })
  fireEvent.click(screen.getByText(runtime.t('sdk:save'))); await screen.findByText(runtime.t('sdk:conflict'))
  // The generic boolean and unsupported renderers use SDK copy, independent of schema shape.
  const ctx = { client: createClient({ ...identity, baseURL: '', fetch: async () => json(row) }), identity, t: translate, slots, entity: 'worker', metadata: { displayField: 'name', fields: { name: { ...manifest.entities.worker.fields.name, type: 'bool' } } }, record: {}, change: () => {} }
  render(h('div', null, renderNode('name', ctx), renderNode({ kind: 'slot', id: 'absent', props: {} }, ctx), h(LanguageSwitcher, { i18n: { ...runtime, t: translate } })))
  await waitFor(() => expect([...consumed].sort()).toEqual([...required].sort()))
})
