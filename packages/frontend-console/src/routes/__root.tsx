import { createRootRoute } from '@tanstack/react-router'
import { MutationEnvironment } from '../mutation-environment'
import { I18nextProvider } from 'react-i18next'
import i18n from '../i18n'
import { Frame } from '../frame'
import { Failure } from '../screens'
export const Route = createRootRoute({ component: Root, notFoundComponent: () => <Failure kind="notFound" /> })

function Root() {
  return <I18nextProvider i18n={i18n} defaultNS="translation"><MutationEnvironment><Frame /></MutationEnvironment></I18nextProvider>
}
