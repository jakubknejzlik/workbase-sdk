import type { InstanceConfig } from './config'

/** Read-only link metadata, independent of the privileged account-link writers. */
export function userLinks(config: InstanceConfig) {
  return Object.entries(config.entities).flatMap(([entity, definition]) => Object.entries(definition.fields)
    .filter(([, field]) => field.userLink).map(([field]) => ({ entity, field })))
}
