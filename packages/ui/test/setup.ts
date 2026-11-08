import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
afterEach(cleanup)

// Browser APIs used by the restored source Select/calendar in jsdom.
Object.defineProperty(window, 'matchMedia', { writable: true, value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) })
HTMLElement.prototype.scrollIntoView = () => {}
HTMLElement.prototype.hasPointerCapture = () => false
HTMLElement.prototype.setPointerCapture = () => {}
HTMLElement.prototype.releasePointerCapture = () => {}
