import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { buildReload, setReloadNavigationCheck } from './build-reload'

/** One host above route content, including bootstrap/loading/error screens. */
export function BuildReloadEnvironment() {
  const router = useRouter()
  useEffect(() => {
    setReloadNavigationCheck(() => router.state.status === 'idle' && !router.state.isLoading)
    const unmount = buildReload.mount()
    const unsubscribe = router.subscribe('onResolved', () => buildReload.recheck())
    window.addEventListener('pageshow', buildReload.pageShow)
    return () => {
      window.removeEventListener('pageshow', buildReload.pageShow)
      unsubscribe(); unmount(); setReloadNavigationCheck(() => true)
    }
  }, [router])
  return null
}
