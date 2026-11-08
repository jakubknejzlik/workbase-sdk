import '@workbasehq/ui/styles.css'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'
import './i18n'
const router = createRouter({ routeTree, basepath: '/' })
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>)
