import { useTranslation } from 'react-i18next'

/** Entity context allows instance namespaces to supply exact resource copy. */
export function useEntityTranslation(entity: string) {
  const translation = useTranslation()
  const t = ((key: string, options?: Record<string, unknown>) => {
    const name = key.startsWith('entitySingular_') ? key.slice('entitySingular_'.length).replaceAll('_', ' ') : undefined
    return translation.t(key, { ...(name ? { defaultValue: translation.t(`entity_${key.slice('entitySingular_'.length)}`, { defaultValue: name.charAt(0).toUpperCase() + name.slice(1) }) } : {}), context: entity, ...options })
  }) as typeof translation.t
  return { ...translation, t }
}
