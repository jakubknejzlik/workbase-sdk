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
const router = createRouter({ routeTree })
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
createRoot(document.getElementById('root')!).render(h(AuthShell, {
  manifest, i18n, navigate: path => router.navigate({ to: path }),
}, h(Shell, { manifest }, h(RouterProvider, { router }))))
