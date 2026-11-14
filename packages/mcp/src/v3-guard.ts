import type { InstanceConfig } from '@workbasehq/core/config'
import { fail, type Change } from './schemas.ts'

const replacements: Partial<Record<Change['kind'], string>> = {
  set_permissions: 'set_entity_access',
  set_policy: 'set_entity_access',
  set_organization_permissions: 'set_system_access',
  add_user_link: 'set_account_link',
  add_role: 'a reviewed role change (V3 role authoring is not supported)',
  remove_role: 'a reviewed role change (V3 role authoring is not supported)',
}

/** Legacy publication serializes defineInstance and would destroy V3 authored sources. */
export function guardV3LegacyWrite(config: InstanceConfig, operation: 'propose' | 'promote' | 'rollback' | 'apply', changes: readonly Change[] = []) {
  if (config.baseline !== 'workbase-sdk') return
  if (operation !== 'propose') fail(`v3_${operation}_unsupported`, `Legacy ${operation} cannot write a V3 instance. V3 domain publication requires a separately reviewed capability.`, 409)
  for (const change of changes) {
    const replacement = replacements[change.kind]
    if (replacement) fail('v3_unsupported_change', `${change.kind} is unsupported on V3 instances; use ${replacement}.`, 409)
  }
}
