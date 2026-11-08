import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { humanizeConsoleKey } from './translation-fallback'
import { localeResources } from './locale-resources'
i18n.use(initReactI18next).init({ resources: localeResources, parseMissingKeyHandler: humanizeConsoleKey, lng: localStorage.getItem('console-language') === 'cs' ? 'cs' : 'en', fallbackLng: 'en', fallbackNS: 'translation', interpolation: { escapeValue: false } })
export default i18n

let applyingDefault = false
i18n.on('languageChanged', language => { if (!applyingDefault) localStorage.setItem('console-language', language); document.documentElement.lang = language })
document.documentElement.lang = i18n.language

/** An instance default is not a user preference; explicit choices survive defaults. */
export function applyInstanceLanguage(language: 'en' | 'cs' = 'en') {
  if (['en', 'cs'].includes(localStorage.getItem('console-language') ?? '')) return
  if (i18n.language !== language) {
    applyingDefault = true
    void i18n.changeLanguage(language).finally(() => { applyingDefault = false })
  }
}
