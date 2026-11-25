import { useLayoutEffect, useRef, type PropsWithChildren, type ReactNode } from 'react'

/** Shared settings surface; host supplies authorized native links and translations. */
export const SettingsLayout = ({ children, title, navigation }: PropsWithChildren<{ title: string; navigation: ReactNode }>) => {
  const nav = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const element = nav.current
    const active = element?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!element || !active) return
    const viewport = element.getBoundingClientRect(); const link = active.getBoundingClientRect()
    // Reveal selection within this scroller without moving the page or focus.
    if (link.left < viewport.left) element.scrollLeft += link.left - viewport.left - 8
    else if (link.right > viewport.right) element.scrollLeft += link.right - viewport.right + 8
  }, [navigation])
  return (
  <div data-slot="settings-layout" className="min-w-0 flex-1 space-y-6">
    <h1 tabIndex={-1} className="text-[32px] font-normal">{title}</h1>
    <div data-slot="settings-navigation" className="min-w-0 rounded-[var(--radius-panel)] border bg-card">
      <nav ref={nav} aria-label={title} className="flex min-w-0 overflow-x-auto">{navigation}</nav>
    </div>
    <div data-slot="settings-content" className="min-w-0">{children}</div>
  </div>
  )
}
