import cs from './locales/cs.json'
import en from './locales/en.json'
export const sdkCatalogs: Record<string, Record<string, string>> = { cs, en }
export type Catalogs = Record<string, Record<string, Record<string, string>>>
/** Shared by build and runtime: SDK overrides are partial, flat catalogs. */
export function mergeCatalogs(languages: readonly string[], catalogs: Catalogs): Catalogs {
  return Object.fromEntries(languages.map(lang => {
    if (!sdkCatalogs[lang]) throw new Error('Unsupported language: ' + lang)
    return [lang, { domain: { ...catalogs[lang]?.domain }, ui: { ...catalogs[lang]?.ui }, sdk: { ...sdkCatalogs[lang], ...catalogs[lang]?.sdk } }]
  }))
}
