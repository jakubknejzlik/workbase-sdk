import { useEffect, useState } from 'react'
export function useIsMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => { if (typeof window.matchMedia !== 'function') return; const media = window.matchMedia('(max-width: 767px)'); const update = () => setMobile(media.matches); media.addEventListener('change', update); update(); return () => media.removeEventListener('change', update) }, [])
  return mobile
}
