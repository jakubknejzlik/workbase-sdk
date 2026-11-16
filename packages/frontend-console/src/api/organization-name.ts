import { organizationNameReasons, type OrganizationNameReason } from '@workbasehq/core/organization-name'
import { ApiError } from './client'

export function organizationNameServerReason(error: unknown): OrganizationNameReason | undefined {
  if (!(error instanceof ApiError) || error.status !== 400 || error.code !== 'invalid_organization_name') return
  const detail = (error.details as { detail?: { field?: unknown; reason?: unknown } } | undefined)?.detail
  if (detail?.field === 'name' && organizationNameReasons.includes(detail.reason as OrganizationNameReason)) return detail.reason as OrganizationNameReason
}
