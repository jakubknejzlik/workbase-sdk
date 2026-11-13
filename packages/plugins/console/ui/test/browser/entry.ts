declare const location: { search: string }
declare const document: { getElementById(id: string): Element | null }
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { Session, Shell, RouteView, AccessCard, LanguageSwitcher } from '../../src/react'
import { entityListPage, entityCreatePage, entityDetailPage, entityEditPage, p, slot } from '../../src/index'
import { createI18n } from '../../src/i18n'
import type { Manifest } from '../../src/check'
const fields = { name: { type: 'text', required: true, readOnly: false, computed: false, userLink: false }, user: { type: 'ref', required: false, readOnly: false, computed: false, userLink: true } }
const slots = { accessCard: { contexts: ['record' as const], props: { account: p.field('userLink'), access: p.access() }, component: AccessCard } }
const list = entityListPage('worker', { title: 'items.list', layout: ['name'] })
const create = entityCreatePage('worker', { title: 'items.new', layout: ['name'], omit: ['user'] })
const detail = entityDetailPage('worker', { title: 'items.detail', recordParam: 'workerId', layout: ['name', slot('accessCard', { account: 'user' })] })
const edit = entityEditPage('worker', { title: 'items.edit', recordParam: 'workerId', layout: ['name'], omit: ['user'] })
const routes = [list, create, detail, edit].map((definition, i) => ({ ...definition, path: ['/workers', '/workers/new', '/workers/$workerId', '/workers/$workerId/edit'][i], source: 'ui/items.ts', links: { list: { to: '/workers', bind: {} }, detail: { to: '/workers/$workerId', bind: { workerId: 'record.id' } }, edit: { to: '/workers/$workerId/edit', bind: { workerId: 'record.id' } } } }))
const manifest = { version: 3, configHash: 'browser', keys: {}, slots: {}, entities: { worker: { displayField: 'name', fields } }, routes, nav: [{ title: 'items.list', link: { to: '/workers', bind: {} } }] } as Manifest
const lang = new URLSearchParams(location.search).get('lang') ?? 'en'
const i18n = createI18n({ languages: ['en', 'cs'], profile: { language: lang }, catalogs: Object.fromEntries(['en', 'cs'].map(language => [language, { ui: { 'items.list': language === 'cs' ? 'Pracovníci' : 'People', 'items.new': language === 'cs' ? 'Nový záznam' : 'New record', 'items.detail': 'Detail', 'items.edit': language === 'cs' ? 'Úprava' : 'Editing' }, domain: { 'field.worker.name': language === 'cs' ? 'Jméno' : 'Name', 'entity.worker_one': 'Person', 'entity.worker_few': 'People', 'entity.worker_many': 'People', 'entity.worker_other': 'People' } }])) })
const root = createRootRoute({ component: () => h(Session, { orgId: 'org-a', t: i18n.t, i18n, slots }, h(Shell, { manifest }, h(LanguageSwitcher, { i18n }), h(Outlet))) })
const tree = root.addChildren(routes.map(definition => {
  const route = createRoute({ getParentRoute: () => root, path: definition.path, component: () => h(RouteView, { definition, route: definition, routes, entities: manifest.entities, params: route.useParams(), search: {}, slots }) })
  return route
}))
const router = createRouter({ routeTree: tree })
createRoot(document.getElementById('app')!).render(h(RouterProvider, { router }))
