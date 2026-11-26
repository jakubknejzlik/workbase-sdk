import { createElement as h, useRef, useState, type ReactNode } from 'react'
import type { Manifest } from '../check'
import { buildPath } from '../index'
import { gate } from '../gate'
import { useRuntime } from './index'
export function Shell({ manifest, children, params = {} }: { manifest: Manifest; children?: ReactNode; params?: Record<string, string | number> }) {
  const { caps, t: translate } = useRuntime(), permission = gate(caps, manifest)
  const [open, setOpen] = useState(false), button = useRef<(HTMLButtonElement & { focus(): void }) | null>(null)
  const close = () => { setOpen(false); button.current?.focus() }
  return h('div', { className: 'wb-ui wb-shell', onKeyDown: (event: { key: string; preventDefault(): void }) => { if (open && event.key === 'Escape') { event.preventDefault(); close() } } },
    h('button', { ref: button, className: 'wb-control wb-menu', type: 'button', 'aria-expanded': open, 'aria-controls': 'wb-navigation', onClick: () => setOpen(value => !value) }, translate('sdk:navigation')),
    h('nav', { id: 'wb-navigation', 'data-open': open, 'aria-label': translate('sdk:navigation') }, ...manifest.nav.filter(item => {
      const route = manifest.routes.find(route => route.path === item.link.to)
      return route && permission.allows(route) && Object.keys(item.link.bind).every(key => Object.hasOwn(params, key))
    }).map(item => h('a', { key: item.title, href: buildPath(item.link.to, Object.fromEntries(Object.keys(item.link.bind).map(key => [key, params[key]]))), onClick: close }, translate('ui:' + item.title)))), children)
}
