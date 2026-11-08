import { useEffect } from 'react'

export const instanceTitle = (displayName?: string) => displayName?.trim() || 'Workbase'

/** The page already renders its authorized, translated label. Reuse it without a query. */
export function useConsoleTitle(displayName: string | undefined, pathname: string) {
  useEffect(() => {
    const title = instanceTitle(displayName)
    const update = () => {
      const label = document.querySelector('main h1')?.textContent?.trim()
      document.title = label && label !== title ? `${label} · ${title}` : title
    }
    update()
    // Pages and their async labels can change without a route change (or replace main).
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [displayName, pathname])
}
