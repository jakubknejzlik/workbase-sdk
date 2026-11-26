import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { AuthShell, createAuthI18n, Shell } from '@workbasehq/plugins/console/ui/react'
import type { Manifest } from '@workbasehq/plugins/console/ui/check'
import { routeTree } from '../.workbase-ui/routeTree.gen'
import metadata from '../.workbase-ui/manifest.json'
import catalogs from '../.workbase-ui/locales.json'

const manifest = metadata as unknown as Manifest
const i18n = createAuthI18n({ languages: Object.keys(catalogs), catalogs })
const home = manifest.routes.some(route => route.path === '/') ? '/'
  : manifest.nav.find(item => !Object.keys(item.link.bind).length)?.link.to ?? '/'
if (location.pathname === '/' && home !== '/') history.replaceState(null, '', home + location.search)
const router = createRouter({ routeTree })
const navigate = (path: string) => router.navigate({ to: path === '/' ? home : path })
createRoot(document.getElementById('app')!).render(
  h(AuthShell, { manifest, i18n, navigate },
    h(Shell, { manifest }, h(RouterProvider, { router }))),
)
