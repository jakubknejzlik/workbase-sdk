import { createContext, useContext, useEffect, useRef } from 'react'
export const AuthDirtyContext = createContext<((owner: symbol, dirty: boolean) => void) | null>(null)
/** Registration is local to the owning shell and cleans up on scope replacement. */
export function useAuthDirty(dirty: boolean) {
  const report = useContext(AuthDirtyContext), owner = useRef(Symbol())
  useEffect(() => { report?.(owner.current, dirty); return () => report?.(owner.current, false) }, [dirty, report])
}
