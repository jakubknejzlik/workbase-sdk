import { createContext } from 'react'
import type { Translate } from './i18n'

/** Shared by the authored t import and ConsoleProvider, never a global translator. */
export const TranslationContext = createContext<Translate | null>(null)
