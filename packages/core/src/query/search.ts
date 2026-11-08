import catalogs from './enum-labels.json'
const booleanLabels = { en: { yes: 'Yes', no: 'No' }, cs: { yes: 'Ano', no: 'Ne' } }

/** Shared enum copy. Context precedes the generic value key, just like i18next. */
export function valueLabel(config: { enumLabels?: Record<string, Record<string, string>> }, entity: string, key: string, locale = 'en') {
  const language = locale.startsWith('cs') ? 'cs' : 'en'
  const base: Record<string, string> = { ...catalogs[language], ...booleanLabels[language] }
  const overrides: Record<string, string> = config.enumLabels?.[language] ?? {}
  return overrides[`${key}_${entity}`] ?? overrides[key] ?? base[`${key}_${entity}`] ?? base[key] ?? key
}

export function enumLabel(config: { enumLabels?: Record<string, Record<string, string>> }, entity: string, value: string, locale = 'en') {
  const key = `value_${value}`; const label = valueLabel(config, entity, key, locale)
  return label === key ? value : label
}
