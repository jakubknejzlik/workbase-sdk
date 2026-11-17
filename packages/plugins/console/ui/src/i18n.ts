import { createInstance } from 'i18next'
import { use } from 'react'
import { TranslationContext } from './i18n-context'
import { mergeCatalogs, type Catalogs } from './catalogs'
export { mergeCatalogs, sdkCatalogs } from './catalogs'
export type { Catalogs } from './catalogs'
export type Translate = (key: string, variables?: Record<string, string | number>) => string
export function resolveLanguage(profile: { language?: string | null } | null | undefined, languages: readonly string[]): string {
  if (!languages.length) throw new Error('At least one language is required')
  return profile?.language && languages.includes(profile.language) ? profile.language : languages[0]
}
export type I18n = ReturnType<typeof createI18n>
/** No language detection or storage; catalogs are bundled into the Instance. */
export function createI18n(options: { languages: readonly string[]; profile?: { language?: string | null } | null; catalogs: Catalogs }) {
  const languages = [...options.languages], instance = createInstance(), listeners = new Set<() => void>()
  void instance.init({ lng: resolveLanguage(options.profile, languages), supportedLngs: languages, load: 'currentOnly', resources: mergeCatalogs(languages, options.catalogs),
    ns: ['domain', 'ui', 'sdk'], defaultNS: 'ui', keySeparator: false, fallbackLng: false, fallbackNS: false, initAsync: false, returnEmptyString: false,
    interpolation: { escapeValue: false } })
  const translate: Translate = (key, variables = {}) => {
    const id = key.includes(':') ? key : 'ui:' + key
    const count = typeof variables.count === 'number' ? variables.count : undefined
    if (!instance.exists(id, { count })) { console.error('Missing translation: ' + id); return '⟦' + id + '⟧' }
    return String(instance.t(id, { replace: variables, count }))
  }
  instance.on('languageChanged', () => listeners.forEach(listener => listener()))
  return { t: translate, languages, language: () => instance.language,
    changeLanguage: async (language: string) => { if (!languages.includes(language)) throw new Error('Unconfigured language: ' + language); await instance.changeLanguage(language) },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
let initialized = false
/** Initialize a host runtime; authored TSX resolves its translator from ConsoleProvider. */
export function initI18n(options: Parameters<typeof createI18n>[0]): I18n {
  const runtime = createI18n(options)
  initialized = true
  return runtime
}
export const t: Translate = (key, variables) => {
  if (!initialized) throw new Error('initI18n is required before rendering authored TSX')
  // React's use(context) permits translation calls in conditionals and loops.
  const translate = use(TranslationContext)
  if (!translate) throw new Error('ConsoleProvider is required for authored t; use the Instance i18n.t outside React')
  return translate(key, variables)
}
