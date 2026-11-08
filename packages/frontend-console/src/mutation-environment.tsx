import { type ReactNode } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { MutationLabelsProvider, RegistryLabelsProvider, cs, enUS, Toaster, blockMutationNavigation, hasUnsavedMutation } from '@workbasehq/ui'

/** Router and i18n bindings for the data-free UI lifecycle. One toast host per app. */
export function MutationEnvironment({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation()
  useBlocker({ shouldBlockFn: blockMutationNavigation, enableBeforeUnload: hasUnsavedMutation })
  return <MutationLabelsProvider value={{ saving: t('saving'), saved: t('mutationSaved'), close: t('close'), discardTitle: t('discardChanges'), discardMessage: t('discardMessage'), discard: t('discard'), continueEditing: t('continueEditing') }}>
    <RegistryLabelsProvider value={{ yes: t('yes'), no: t('no'), unfilled: t('unfilled'), locale: i18n.language.startsWith('cs') ? cs : enUS, date: t('pickDate'), datetime: t('pickDateTime'), time: t('fieldTime'), decrease: t('decreaseValue'), increase: t('increaseValue'), swatch: label => t('colourSwatch', { label }) }}>{children}</RegistryLabelsProvider><Toaster position="bottom-right" visibleToasts={1} containerAriaLabel={t('notifications')} />
  </MutationLabelsProvider>
}
