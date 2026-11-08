// Generated composition only; RFC 0005 decision 6.
import { createFileRoute } from '@tanstack/react-router'
import { ReadPage } from '../../read'
import { RecordBreadcrumb } from '../../Breadcrumbs'
export const Route = createFileRoute('/o/$orgId/e/$entity/$id')({ staticData: { title: 'record', crumb: <DetailBreadcrumb /> }, component: Detail })
function DetailBreadcrumb() { return <RecordBreadcrumb {...Route.useParams()} /> }
function Detail() { return <ReadPage {...Route.useParams()} /> }
