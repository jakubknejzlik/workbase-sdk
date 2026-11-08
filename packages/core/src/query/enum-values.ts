/** Authoritative built-in roles, consumed by config's exhaustive runtime grant
 * table and the release label guard. Instance roles remain configuration-owned. */
export const coreEnums = {
  role: ['owner', 'dispatcher', 'viewer', 'administrator', 'unknown'],
} as const

export type CoreRole = typeof coreEnums.role[number]
