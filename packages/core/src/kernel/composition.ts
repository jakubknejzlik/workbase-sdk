import type { WorkbasePlugin } from './plugin'

/** Contract majors are deliberately narrower than package semver. Only login is multi-provider. */
export function resolvePlugins(input: readonly WorkbasePlugin[], interactive = false) {
  const ownContracts = (plugin: WorkbasePlugin, key: 'provides' | 'requires' | 'optionalRequires') => Object.hasOwn(plugin, key) ? Object.fromEntries(Object.entries(plugin[key] ?? {})) : {}
  const contracts = new Map(input.map(plugin => [plugin, ownContracts(plugin, 'provides')]))
  const names = new Set<string>()
  const providers = new Map<string, WorkbasePlugin[]>()
  const identifier = /^[a-z][a-z0-9_-]*$/
  for (const plugin of input) {
    if (!identifier.test(plugin.name) || !plugin.version || names.has(plugin.name)) throw new Error(`Invalid or duplicate plugin: ${plugin.name}`)
    names.add(plugin.name)
    const migrations = new Set<string>()
    for (const migration of plugin.migrations ?? []) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(migration.name)) throw new Error(`Invalid plugin migration: ${plugin.name}/${migration.name}`)
      if (migrations.has(migration.name)) throw new Error(`Duplicate plugin migration: ${plugin.name}/${migration.name}`)
      migrations.add(migration.name)
    }
    for (const [contract, version] of Object.entries(contracts.get(plugin)!)) {
      if (!identifier.test(contract) || !/^(0|[1-9]\d*)\.x$/.test(version)) throw new Error(`Invalid contract provided by ${plugin.name}: ${contract}@${version}; expected <major>.x`)
      const existing = providers.get(contract) ?? []
      if (existing.length && contract !== 'login') throw new Error(`Duplicate provider for ${contract}: ${existing[0].name}, ${plugin.name}`)
      if (existing.some(p => contracts.get(p)![contract] !== version)) throw new Error(`Incompatible providers for ${contract}: ${version}`)
      providers.set(contract, [...existing, plugin])
    }
    if (plugin.contributes?.console && contracts.get(plugin)!.console !== '1.x' && ownContracts(plugin, 'requires').console !== '^1' && ownContracts(plugin, 'optionalRequires').console !== '^1') throw new Error(`Plugin ${plugin.name}: console contributions require console@^1`)
    const provides = contracts.get(plugin)!
    if (plugin.configure && !provides.permissions) throw new Error(`Plugin ${plugin.name}: role configuration requires the permissions contract`)
    if (plugin.authorization && !provides.permissions) throw new Error(`Plugin ${plugin.name}: authorization requires the permissions contract`)
    if (plugin.authenticateCredential && !provides['machine-credentials']) throw new Error(`Plugin ${plugin.name}: authenticateCredential requires the machine-credentials contract`)
    if (plugin.authenticate && !provides.login) throw new Error(`Plugin ${plugin.name}: authenticate requires the login contract`)
    if (plugin.mailOutbox && !provides['mail-outbox']) throw new Error(`Plugin ${plugin.name}: mailOutbox requires the mail-outbox contract`)
    if (plugin.audit && !provides.audit) throw new Error(`Plugin ${plugin.name}: audit port requires the audit contract`)
    if (provides.login && !ownContracts(plugin, 'requires').identity) throw new Error(`Plugin ${plugin.name}: login requires identity`)

  }
  for (const contract of ['mail-outbox', 'audit'] as const) for (const plugin of providers.get(contract) ?? []) {
    if (contracts.get(plugin)![contract] !== '1.x' || !(contract === 'audit' ? plugin.audit : plugin.mailOutbox)) throw new Error(`Plugin ${plugin.name}: ${contract} requires a 1.x port`)
  }
  for (const plugin of providers.get('permissions') ?? []) {
    const provides = contracts.get(plugin)!
    if (provides.permissions && (provides.permissions !== '1.x' || plugin.authorization !== true || typeof plugin.tableFilter !== 'function' || typeof plugin.commandGuard !== 'function')) {
      throw new Error(`Plugin ${plugin.name}: permissions requires 1.x, authorization:true, tableFilter and commandGuard`)
    }
  }
  for (const plugin of providers.get('console') ?? []) if (contracts.get(plugin)!.console !== '1.x' || !plugin.validateConsole || !plugin.consoleRegistry) throw new Error(`Plugin ${plugin.name}: console requires a complete 1.x registry provider`)
  if (interactive && !providers.has('login')) throw new Error('Interactive instance requires a login provider')
  const dependencies = new Map<WorkbasePlugin, WorkbasePlugin[]>()
  for (const plugin of input) {
    const deps: WorkbasePlugin[] = []
    for (const [required, requirements] of [[true, ownContracts(plugin, 'requires')], [false, ownContracts(plugin, 'optionalRequires')]] as const) {
      for (const [contract, range] of Object.entries(requirements)) {
        if (!identifier.test(contract) || !/^\^(0|[1-9]\d*)$/.test(range)) throw new Error(`Plugin ${plugin.name}: invalid requirement ${contract}@${range}; expected ^<major>`)
        const matches = providers.get(contract) ?? []
        if (!matches.length && required) throw new Error(`Plugin ${plugin.name}: missing required contract ${contract}@${range}`)
        for (const provider of matches) {
          const version = contracts.get(provider)![contract]
          if (version !== `${range.slice(1)}.x`) throw new Error(`Plugin ${plugin.name}: ${contract}@${range} incompatible with ${provider.name} providing ${version}`)
          deps.push(provider)
        }
      }
    }
    dependencies.set(plugin, deps)
  }
  const ordered: WorkbasePlugin[] = []
  const visiting: WorkbasePlugin[] = []
  const visited = new Set<WorkbasePlugin>()
  function visit(plugin: WorkbasePlugin) {
    if (visited.has(plugin)) return
    if (visiting.includes(plugin)) throw new Error(`Plugin dependency cycle: ${[...visiting.slice(visiting.indexOf(plugin)), plugin].map(p => p.name).join(' -> ')}`)
    visiting.push(plugin)
    for (const dependency of dependencies.get(plugin)!) visit(dependency)
    visiting.pop(); visited.add(plugin); ordered.push(plugin)
  }
  for (const plugin of input) visit(plugin)
  return { plugins: Object.freeze(ordered), providers: providers as ReadonlyMap<string, readonly WorkbasePlugin[]> }
}
