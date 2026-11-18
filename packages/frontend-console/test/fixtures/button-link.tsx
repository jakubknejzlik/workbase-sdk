import { useState, type ComponentProps, type ReactNode } from 'react'
import { createRootRoute, createRoute, createRouter, Link, RouterProvider } from '@tanstack/react-router'

function createButtonLinkRouter(children: ReactNode) {
  const root = createRootRoute({ component: () => children })
  const destination = createRoute({
    getParentRoute: () => root,
    path: '/button-disabled-links.html',
    validateSearch: (search: Record<string, unknown>) => ({ destination: Number(search.destination) || undefined }),
  })
  const fallback = createRoute({ getParentRoute: () => root, path: '$' })
  return createRouter({ routeTree: root.addChildren([destination, fallback]) })
}

// Use the real router integration: Link derives href from `to`, even if a Slot
// attempts to remove href. The observer proves disabled children never render.
export function ButtonRouterLink({ onRender, ...props }: ComponentProps<'a'> & { onRender?: () => void }) {
  onRender?.()
  return <Link<ReturnType<typeof createButtonLinkRouter>, string, '/button-disabled-links.html'>
    to="/button-disabled-links.html" search={{ destination: 1 }} {...props} />
}

export function ButtonLinkRouter({ children }: { children: ReactNode }) {
  const [router] = useState(() => createButtonLinkRouter(children))
  return <RouterProvider router={router} />
}
