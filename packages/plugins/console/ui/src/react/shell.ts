import { createElement as h, useRef, useState, type ReactNode } from 'react'
import type { Manifest } from '../check'
import { buildPath } from '../index'
import { gate } from '../gate'
import { useRuntime } from './index'
const css = `.wb-shell{max-width:100%;min-width:0;overflow-wrap:anywhere}.wb-shell *{box-sizing:border-box;min-width:0}.wb-shell input,.wb-shell select{max-width:100%}.wb-shell nav a{display:block;padding:.6rem}.wb-menu{display:none}@media(max-width:500px){.wb-menu{display:block}.wb-shell nav[data-open=false]{display:none}}`
export function Shell({ manifest, children, params = {} }: { manifest: Manifest; children?: ReactNode; params?: Record<string, string | number> }) {
  const { caps, t: translate } = useRuntime(), permission = gate(caps, manifest)
  const [open, setOpen] = useState(false), button = useRef<(HTMLButtonElement & { focus(): void }) | null>(null)
  const close = () => { setOpen(false); button.current?.focus() }
  return h('div', { className: 'wb-shell', onKeyDown: (event: { key: string; preventDefault(): void }) => { if (open && event.key === 'Escape') { event.preventDefault(); close() } } },
    h('style', null, css),
    h('button', { ref: button, className: 'wb-menu', type: 'button', 'aria-expanded': open, 'aria-controls': 'wb-navigation', onClick: () => setOpen(value => !value) }, translate('sdk:navigation')),
    h('nav', { id: 'wb-navigation', 'data-open': open, 'aria-label': translate('sdk:navigation') }, ...manifest.nav.filter(item => {
      const route = manifest.routes.find(route => route.path === item.link.to)
      return route && permission.allows(route) && Object.keys(item.link.bind).every(key => Object.hasOwn(params, key))
    }).map(item => h('a', { key: item.title, href: buildPath(item.link.to, Object.fromEntries(Object.keys(item.link.bind).map(key => [key, params[key]]))), onClick: close }, translate('ui:' + item.title)))), children)
}
