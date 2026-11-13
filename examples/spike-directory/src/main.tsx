import React from 'react'
import { createRoot } from 'react-dom/client'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { routeTree } from '../.ui-v3/routeTree.gen'
import { UIProvider, createMemoryStore } from '@workbasehq/ui-v3/react'
import '@workbasehq/ui-v3/styles.css'
import schema, { seed } from '../schema'
import slots from '../ui/-slots'
import nav from '../ui/nav'
import pages from '../.ui-v3/pages'
import { t } from './i18n'
const store = createMemoryStore(schema, seed)
const router = createRouter({ routeTree, defaultPreload: 'intent' })
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
createRoot(document.getElementById('root')!).render(<React.StrictMode><UIProvider schema={schema} slots={slots} nav={nav} pages={pages} store={store} t={t}><RouterProvider router={router} /></UIProvider></React.StrictMode>)
