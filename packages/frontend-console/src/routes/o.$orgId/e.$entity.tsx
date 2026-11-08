import { Database } from 'lucide-react'
import { validateListSearch } from '@workbasehq/console-generated/list-model'
// Generated composition only; RFC 0005 decision 6.
import { createFileRoute, Outlet, useChildMatches } from '@tanstack/react-router'
import { ReadPage } from '../../read'
export const Route = createFileRoute('/o/$orgId/e/$entity')({ validateSearch: validateListSearch, staticData: { title: 'entities', crumb: 'entities', icon: <Database /> }, component: Nested })
function List() { return <ReadPage {...Route.useParams()} /> }
function Nested() { return useChildMatches().length ? <Outlet /> : <List /> }
