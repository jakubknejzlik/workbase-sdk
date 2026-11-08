import { useEffect, useMemo, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { localeResources } from './locale-resources'
import { useRuntimeModel } from './api/runtime-model'
import { Loading, QueryError } from './screens'
import { humanizeConsoleKey } from './translation-fallback'

/** Each organization/authority projection owns its resource store; none enters global i18n. */
export function RuntimeLocalization({ orgId, children }: { orgId: string; children: ReactNode }) {
  const runtime = useRuntimeModel(orgId)
  const { i18n: parent } = useTranslation()
  const labels = runtime.error ? undefined : runtime.data?.model.enumLabels
  const scoped = useMemo(() => {
    const instance = createInstance()
    void instance.init({ initImmediate: false, lng: parent.language, fallbackLng: 'en',
      resources: Object.fromEntries(Object.entries(localeResources).map(([language, resource]) => [language, { translation: { ...resource.translation, ...labels?.[language] } }])),
      parseMissingKeyHandler: humanizeConsoleKey, interpolation: { escapeValue: false },
    })
    return instance
  }, [parent.language, labels])
  useEffect(() => {
    const change = (language: string) => { if (parent.language !== language) void parent.changeLanguage(language) }
    scoped.on('languageChanged', change)
    return () => { scoped.off('languageChanged', change) }
  }, [parent, scoped])
  if (runtime.error) return <QueryError error={runtime.error} />
  if (!runtime.data) return <Loading />
  return <I18nextProvider i18n={scoped} defaultNS="translation">{children}</I18nextProvider>
}
