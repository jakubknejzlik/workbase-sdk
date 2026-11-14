/** Build-time audit only. Records the composed policy plus selected enforcement inputs;
 * not a complete model of authorization (see docs/sdk/access-lock.md § Scope). */
import { realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { enforcementInputs, type AccessKernel } from './access-inputs'
import type { SourceMap } from './schema/load'

export interface AccessLockOptions {
  root: string
  sources: SourceMap
}
export interface AccessLockFiles { json: string; md: string }
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]))
  return value
}
const json = (value: unknown) => JSON.stringify(canonical(value))
const cell = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;').replaceAll('\n', '<br>')

export function serializeAccessLock(kernel: AccessKernel, options: AccessLockOptions): AccessLockFiles {
  const policy = kernel.config.effectiveAccess
  if (!policy) throw new Error('Access lock requires a composed effectiveAccess policy')
  const inputs = enforcementInputs(kernel)
  const root = realpathSync(resolve(options.root))
  const locations: Record<string, { file: string; line: number }> = {}
  const locate = (key: string, fallback = key) => {
    let path = options.sources[key] ? key : fallback
    while (!options.sources[path] && path) path = path.split('.').slice(0, -1).join('.')
    const source = options.sources[path]
    if (!source) throw new Error(`Missing source location for ${key}; provide the config source map`)
    const file = relative(root, resolve(root, source.file)).split(sep).join('/')
    if (isAbsolute(file) || file === '..' || file.startsWith('../')) throw new Error(`Source for ${key} is outside the repository root`)
    locations[key] = { file, line: source.line }
    return `${file}:${source.line}`
  }
  const lines = ['# Access lock', '', 'Generated from kernel.config.effectiveAccess. Regenerate with `bun run access:lock`.', '',
    'Held-role grants form a union; explicit deny wins and none supplies no grant. Independent authority layers combine by intersection.', '',
    'Source locations identify the rule or its enclosing registration declaration. Executable code remains opaque.', '',
    '## Entity operations', '', '| Role | Entity | Read | Create | Update | Delete |', '| --- | --- | --- | --- | --- | --- |']
  const groups = new Map<string, Map<string, string>>()
  for (const rule of policy.entities) {
    const key = json([rule.role, rule.entity])
    const group = groups.get(key) ?? new Map<string, string>(); groups.set(key, group)
    const details = [rule.decision, `where=${json(rule.where)}`, `fields=${json(rule.fields)}`,
      `predicates=${json(rule.predicates)}`, `dependencies=${json(rule.dependencies)}`, locate(rule.source)]
    group.set(rule.operation, cell(details.join('; ')))
    for (const name of rule.predicates) locate(`access.predicates.${name}`)
  }
  for (const [key, operations] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const [role, entity] = JSON.parse(key)
    lines.push(`| ${cell(role)} | ${cell(entity)} | ${['read', 'create', 'update', 'delete'].map(op => operations.get(op) ?? 'missing').join(' | ')} |`)
  }
  lines.push('', '## System and account privileges', '', '| Role | Action | Decision | Target | Source |', '| --- | --- | --- | --- | --- |')
  for (const rule of policy.system) lines.push(`| ${cell(rule.role)} | ${cell(rule.action)} | ${rule.decision} | ${cell(json(rule.target))} | ${cell(locate(rule.source))} |`)
  if (policy.accountLinks) {
    lines.push('', '## Account link invitation roles', '')
    for (const [entity, mapping] of Object.entries(policy.accountLinks)) lines.push(`- ${cell(entity)}: ${cell(mapping.invitationRole)} (${cell(locate(`access.accountLinks.${entity}.invitationRole`))})`)
  }
  lines.push('', '## Record actions', '', '| Entity | Action | Command | Conditions | Dependencies | Source |', '| --- | --- | --- | --- | --- | --- |')
  for (const action of policy.actions) lines.push(`| ${cell(action.entity)} | ${cell(action.name)} | ${cell(action.command)} | ${cell(json(action.conditions))} | ${cell(json(action.dependencies))} | ${cell(locate(action.source))} |`)
  lines.push('', '## Registered command guards', '', '| Command | Permission | Additional permissions | Executable checks | Registration source |', '| --- | --- | --- | --- | --- |')
  for (const guard of policy.guards) lines.push(`| ${cell(guard.name)} | ${cell(json(guard.permission))} | ${cell(json(guard.additionalPermissions))} | opaque | ${cell(locate(`guards.${guard.name}`, 'commands'))} |`)
  lines.push('', '## Opaque executable hooks', '')
  for (const hook of policy.opaqueHooks) lines.push(`- ${cell(hook)}: opaque (${cell(locate(`hooks.${hook}`, 'plugins'))})`)
  if (!policy.opaqueHooks.length) lines.push('None registered.')
  lines.push('', '## Named predicate sources', '')
  const predicates = [...new Set(policy.entities.flatMap(rule => rule.predicates))].sort()
  for (const name of predicates) lines.push(`- ${cell(name)}: ${cell(locate(`access.predicates.${name}`))}`)
  if (!predicates.length) lines.push('None used.')
  lines.push('', '## Enforcement inputs', '', 'Selected resolved kernel/config inputs used alongside the compiled grants (curated, not exhaustive; see docs/sdk/access-lock.md § Scope). Executable bodies remain opaque.', '', '| Input | Resolved value |', '| --- | --- |')
  for (const [key, value] of Object.entries(canonical(inputs) as Record<string, unknown>)) {
    if (key === 'entities') for (const [entity, definition] of Object.entries(value as Record<string, Record<string, unknown>>)) {
      for (const [part, data] of Object.entries(definition)) lines.push(`| ${cell(`${entity} / ${part}`)} | ${cell(json(data))} |`)
    } else lines.push(`| ${cell(key)} | ${cell(json(value))} |`)
  }
  // Compact JSON keeps the full normalized representation together; no derived grants.
  return { json: json({ effectiveAccess: policy, enforcementInputs: inputs, sources: locations }) + '\n', md: lines.join('\n') + '\n' }
}

function diff(previous: string, current: string): string[] {
  try {
    const before = JSON.parse(previous); const after = JSON.parse(current)
    const changes: string[] = []
    function inputs(old: any, next: any, path: string) {
      if (json(old) === json(next)) return
      if (old && next && typeof old === 'object' && typeof next === 'object' && !Array.isArray(old) && !Array.isArray(next)) {
        for (const key of [...new Set([...Object.keys(old), ...Object.keys(next)])].sort()) inputs(old[key], next[key], `${path} / ${key}`)
      } else changes.push(`~ ${path}: ${json(old) ?? 'missing'} -> ${json(next) ?? 'missing'}`)
    }
    for (const [section, key] of [
      ['entities', (r: any) => `${r.role} / ${r.entity} / ${r.operation}`],
      ['system', (r: any) => `${r.role} / ${r.target.entity} / ${r.target.operation} (${r.action})`],
      ['actions', (r: any) => `action ${r.entity} / ${r.name}`],
      ['guards', (r: any) => `command ${r.name}`],
    ] as const) {
      const old = new Map<string, unknown>((before.effectiveAccess[section] ?? []).map((r: any) => [key(r), r]))
      const next = new Map<string, unknown>((after.effectiveAccess[section] ?? []).map((r: any) => [key(r), r]))
      for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) {
        if (json(old.get(id)) !== json(next.get(id))) changes.push(`${old.has(id) ? next.has(id) ? '~' : '-' : '+'} ${id}`)
      }
    }
    if (json(before.effectiveAccess.opaqueHooks) !== json(after.effectiveAccess.opaqueHooks)) changes.push('~ opaque executable hooks')
    if (json(before.effectiveAccess.roles) !== json(after.effectiveAccess.roles)) changes.push('~ configured roles')
    inputs(before.effectiveAccess.accountLinks, after.effectiveAccess.accountLinks, 'account link invitation roles')
    inputs(before.enforcementInputs, after.enforcementInputs, 'enforcement inputs')
    if (json(before.sources) !== json(after.sources)) changes.push('~ source locations')
    return changes.slice(0, 12).concat(changes.length > 12 ? [`… ${changes.length - 12} more changes`] : [])
  } catch { return ['Invalid access.lock.json; regenerate it'] }
}

/** Checks never create directories or touch either lock, including missing/invalid locks. */
export async function syncAccessLock(options: AccessLockOptions & {
  kernel: AccessKernel
  directory?: string
  write?: boolean
}): Promise<{ ok: boolean; message: string }> {
  if (!options.kernel.config.effectiveAccess) {
    if (options.kernel.config.baseline === 'workbase-sdk') throw new Error('Schema config is missing compiled effectiveAccess')
    return { ok: true, message: 'check:access: skip legacy defineInstance config (no access lock)' }
  }
  const files = serializeAccessLock(options.kernel, options)
  const directory = resolve(options.root, options.directory ?? '.')
  const names = ['access.lock.json', 'access.lock.md'] as const
  if (options.write) {
    for (const [i, content] of [files.json, files.md].entries()) await writeFile(resolve(directory, names[i]), content)
    return { ok: true, message: 'access:lock: regenerated access.lock.json and access.lock.md' }
  }
  const previous = await Promise.all(names.map(async name => {
    try { return await readFile(resolve(directory, name), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }))
  const missing = names.filter((_, i) => previous[i] === undefined)
  if (missing.length) return { ok: false, message: `check:access: missing ${missing.join(', ')}; run bun run access:lock` }
  const stale = names.filter((_, i) => previous[i] !== [files.json, files.md][i])
  if (!stale.length) return { ok: true, message: 'check:access: lock files match the compiled policy and listed inputs' }
  return { ok: false, message: [`check:access: stale ${stale.join(', ')}; run bun run access:lock`,
    ...(previous[0] !== files.json ? diff(previous[0]!, files.json) : [])].join('\n') }
}
