import type { EffectiveAccessPolicy } from './access'
import type { AtomicOperation } from './execution/types'
import type { WorkbasePlugin } from './kernel/plugin'
import { isBuiltinPlugin } from './kernel/builtin-source'

/** Resolve code-owned guards once at composition. Audits serialize the same data
 * used by the command port; executable hooks are explicitly opaque, never omitted.
 */
export function accessGuards(policy: EffectiveAccessPolicy, names: readonly string[], commands: readonly AtomicOperation<any>[], plugins: readonly WorkbasePlugin[]): EffectiveAccessPolicy {
  const registry = new Map(commands.map(command => [command.name, command]))
  const canonical = (permission: AtomicOperation['permission']) => 'system' in permission
    ? { system: permission.system } : { entity: permission.entity, operation: permission.operation }
  const key = (permission: AtomicOperation['permission']) => JSON.stringify(canonical(permission))
  return { ...policy,
    guards: [...new Set([...names, ...registry.keys()])].sort().map(name => {
      const command = registry.get(name)
      return { name, permission: command ? canonical(command.permission) : null,
        additionalPermissions: (command?.additionalPermissions ?? []).map(canonical).sort((a, b) => key(a).localeCompare(key(b))),
        // A registered command's prepare/plan can contain further executable checks.
        opaque: true as const,
      }
    }),
    opaqueHooks: plugins.flatMap(plugin => (['tableFilter', 'fieldMask', 'commandGuard'] as const)
      .filter(hook => plugin[hook] && !(isBuiltinPlugin(plugin) && plugin.authorization && plugin.policyInConfig))
      .map(hook => `${plugin.name}.${hook}`)).sort(),
  }
}
