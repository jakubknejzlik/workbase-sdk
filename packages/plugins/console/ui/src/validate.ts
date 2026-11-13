import { sourceAt } from './locations'
export { sourceAt } from './locations'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scanTSX } from './scan'
import { actionReasonKeys } from '@workbasehq/core/schema'
import { loadConfig, SourceError } from '@workbasehq/core/schema/load'
import type { Manifest, Schema } from './check'
import { checkSources, type Sources } from './sources'
import type { Node, Span } from './index'
import { checkDictionaries, type Catalogs } from './dictionaries'
import { sdkCatalogs } from './catalogs'
export type Location = { file: string; line: number; col: number }
export type Finding = Location & { code: string; key?: string; lang?: string; message?: string }
export type KeySource = Location & { plural?: boolean }
export type Scan = { keys: Map<string, KeySource[]>; families: Set<string>; findings: Finding[] }
export const breakpoints = ['xs', 'sm', 'md', 'lg', 'xl'] as const
export function effectiveSpans(span: Span): number[] {
  let previous = 12
  return breakpoints.map(bp => previous = typeof span === 'number' ? span : span[bp] ?? previous)
}
/** Record reasons consume authored dynamic families just like TSX t() calls. */
export function actionFamilies(reasons: readonly string[], families: Manifest['keys']): string[] {
  return Object.keys(families).filter(family => reasons.some(reason => !reason.startsWith('access.') && reason.startsWith(family + '.') && families[family].includes(reason.slice(family.length + 1))))
}
/** Inventory is derived from schema and declarations, never from Instance dictionaries. */
export function requiredKeys(config: { entities: Schema }, manifest: Manifest, scan: Scan, sdkCatalog: Record<string, string>, sources?: Sources, schemaSources: Record<string, { file: string; line: number; column: number }> = {}): Map<string, KeySource[]> {
  const keys = new Map<string, KeySource[]>()
  const at = (file: string, key?: string) => sourceAt(file, sources?.modules.get(file) ?? '', key)
  const add = (key: string, source: KeySource) => keys.set(key, [...keys.get(key) ?? [], source])
  const schemaAt = (path: string): Location => {
    const s = schemaSources[path] ?? schemaSources['']
    return s ? { file: s.file, line: s.line, col: s.column } : at('config.ts')
  }
  for (const [entity, spec] of Object.entries(config.entities)) {
    // defineConfig injects the SDK-owned users projection; it is not an authored domain entity.
    if (entity === 'users') continue
    add(`domain:entity.${entity}`, { ...schemaAt(`entities.${entity}`), plural: true })
    for (const [field, f] of Object.entries(spec.fields)) {
      const location = schemaAt(`entities.${entity}.fields.${field}`)
      add(`domain:field.${entity}.${field}`, location)
      for (const value of f.values ?? []) add(`domain:enum.${entity}.${field}.${value}`, location)
    }
  }
  for (const route of manifest.routes) {
    const file = resolve(sources?.root ?? '.', route.source)
    add('ui:' + route.title, at(file, route.title))
    function walk(nodes: Node[]) {
      for (const node of nodes) if (typeof node !== 'string') {
        if ('title' in node && node.title) add('ui:' + node.title, at(file, node.title))
        if (node.kind === 'action') add('ui:actions.' + node.name, at(file, node.name))
        if (node.kind === 'slot') for (const [prop, spec] of Object.entries(manifest.slots[node.id].props)) {
          if (spec.kind === 'key') add('ui:' + node.props[prop], at(file, String(node.props[prop])))
        } else if (node.kind !== 'action') walk(node.children)
      }
    }
    walk(route.layout)
  }
  for (const item of manifest.nav) add('ui:' + item.title, at(resolve(sources?.root ?? '.', 'ui/nav.ts'), item.title))
  for (const [key, refs] of scan.keys) refs.forEach(ref => add(key, ref))
  for (const family of scan.families) for (const suffix of manifest.keys[family] ?? []) {
    add('ui:' + family + '.' + suffix, at(resolve(sources?.root ?? '.', 'ui/keys.ts'), family))
  }
  for (const key of actionReasonKeys(config as Parameters<typeof actionReasonKeys>[0])) add((key.startsWith('access.') ? 'sdk:' : 'ui:') + key, schemaAt('access'))
  for (const key of Object.keys(sdkCatalog)) add('sdk:' + key, at('SDK catalog', key))
  return keys
}
export function checkStructure(manifest: Manifest, root: string): Finding[] {
  const findings: Finding[] = []
  for (const route of manifest.routes) {
    const file = resolve(root, route.source), text = readFileSync(file, 'utf8'), placed = new Set<string>()
    const fields = route.entity ? manifest.entities[route.entity].fields : {}
    const emit = (code: string, key?: string, message?: string) => findings.push({ code, ...sourceAt(file, text, key && text.includes(key) ? key : route.title), key, message })
    function walk(nodes: Node[], parent?: string) {
      for (const node of nodes) {
        if (typeof node === 'string') {
          placed.add(node)
          if (fields[node]?.userLink) emit('bare-userLink', node)
          continue
        }
        if (node.kind === 'col') {
          if (parent !== 'row') emit('col-parent')
          if (effectiveSpans(node.span).some(n => !Number.isInteger(n) || n < 1 || n > 12)) emit('span-bounds')
        }
        if (node.kind === 'row') for (const [i, bp] of breakpoints.entries()) {
          const spans = node.children.map(child => typeof child !== 'string' && child.kind === 'col' ? effectiveSpans(child.span)[i] : 12)
          if (spans.some(n => n !== 12) && spans.reduce((a, b) => a + b, 0) > 12) emit('row-overflow', undefined, bp)
        }
        if (node.kind === 'slot') {
          for (const [prop, spec] of Object.entries(manifest.slots[node.id].props)) if (spec.kind === 'field') placed.add(String(node.props[prop]))
        } else if (node.kind !== 'action') walk(node.children, node.kind)
      }
    }
    walk(route.layout)
    for (const omit of route.omit) {
      if (!Object.hasOwn(fields, omit)) emit('unknown-omit', omit)
      if (placed.has(omit)) emit('placed-and-omitted', omit)
    }
    if (route.mode && ['detail', 'create', 'edit'].includes(route.mode)) for (const [name, field] of Object.entries(fields)) {
      if (route.mode !== 'detail' && (field.readOnly || field.computed)) continue
      if (!placed.has(name) && !route.omit.includes(name)) emit('unplaced-field', name)
    }
  }
  return findings
}
export async function validateInstance(root: string): Promise<Finding[]> {
  root = resolve(root)
  const findings: Finding[] = []
  const caught = (error: unknown) => {
    const loc = error instanceof SourceError ? error.location : { file: resolve(root, 'config.ts'), line: 1, column: 1 }
    findings.push({ code: 'source', file: loc.file, line: loc.line, col: loc.column, message: String(error) })
  }
  let loaded: Awaited<ReturnType<typeof loadConfig>>, sources: Sources, manifest: Manifest
  try { loaded = await loadConfig(resolve(root, 'config.ts')); sources = checkSources(root) }
  catch (error) { caught(error); return findings }
  try { manifest = await (await import('./vite')).extractManifest(root) }
  catch (error) { caught(error); return findings }
  const scan = scanTSX(sources.modules, manifest.keys)
  for (const family of actionFamilies(actionReasonKeys(loaded.config), manifest.keys)) scan.families.add(family)
  findings.push(...scan.findings)
  findings.push(...checkStructure(manifest, root))
  if (!loaded.config.languages?.length) findings.push({ code: 'missing-languages', file: resolve(root, 'config.ts'), line: 1, col: 1 })
  const catalogs: Catalogs = {}
  for (const lang of loaded.config.languages ?? []) {
    catalogs[lang] = {}
    for (const ns of ['domain', 'ui', 'sdk']) {
      const file = resolve(root, 'locales', lang, ns + '.json')
      if (ns === 'sdk' && !existsSync(file)) continue
      try {
        const text = readFileSync(file, 'utf8'), value = JSON.parse(text)
        if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(v => typeof v !== 'string')) throw new Error('Expected flat string catalog')
        catalogs[lang][ns] = value
      } catch (error) { findings.push({ code: 'catalog', file, line: 1, col: 1, lang, message: String(error) }) }
    }
  }
  for (const family of Object.keys(manifest.keys)) if (!scan.families.has(family)) findings.push({ code: 'unused-family', ...sourceAt(resolve(root, 'ui/keys.ts'), sources.modules.get(resolve(root, 'ui/keys.ts')) ?? '', family), key: family })
  findings.push(...checkDictionaries(root, requiredKeys(loaded.config, manifest, scan, sdkCatalogs.en, sources, loaded.sources), catalogs, sdkCatalogs))
  return findings.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line || a.col - b.col || a.code.localeCompare(b.code, 'en') || (a.key ?? '').localeCompare(b.key ?? '', 'en'))
}
