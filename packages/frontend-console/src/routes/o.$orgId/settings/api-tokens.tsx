import { createFileRoute } from '@tanstack/react-router'
import { PluginPage } from '../../../console-pages'
export const Route = createFileRoute('/o/$orgId/settings/api-tokens')({ staticData: { title: 'tokens', crumb: 'tokens', noLayoutContentPadding: true }, component: Screen })
function Screen() { return <PluginPage key={Route.useParams().orgId} orgId={Route.useParams().orgId} id="machine-credentials.tokens" /> }
