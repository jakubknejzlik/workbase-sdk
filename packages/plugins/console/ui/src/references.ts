import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { loadConfig, SourceError } from '@workbasehq/core/schema/load'
import { nodeSpan, referenceSource, referenceInventory, referenceDiagnostics, validateRemoval, type Reference, type ReferenceInput,
  type ReferenceDiagnostic, type ReferenceKind, type ReferenceTarget, type RemovalIntent, type ReferenceInventory } from '@workbasehq/core/references'
import { referenceOrigins } from './reference-origins'
import { pluginReferences } from './plugin-references'
import type { Manifest } from './check'
import type { Node } from './index'
import type { Sources } from './sources'

/** Collect only validated Console V3 semantics. No identifier-like prose is searched. */
export function consoleReferences(sources: Sources, manifest: Manifest, values: Record<string, unknown>) {
  const origin = referenceOrigins(sources), references: Reference[] = [], diagnostics: ReferenceDiagnostic[] = []
  const add = (file: string, path: string[], kind: ReferenceKind, context: string, target: ReferenceTarget, key?: string) => {
    const at = origin(file, path)
    const owner = `${file}:${path.join('.')}`
    references.push({ kind, target, entityContext: context, source: at.source, owner, key,
      useSites: [...at.uses, at.source].map(source => ({ source, owner, entityContext: context })) })
    if (!at.exact) diagnostics.push({ code: 'reference-provenance', source: at.source, owner,
      message: 'Cannot establish exact reference provenance through this computed UI value.', repairHint: 'Express this reference with literal SDK helpers or an imported literal data source.' })
  }
  for (const route of manifest.routes) {
    const file = resolve(sources.root, route.source), entity = route.entity
    if (entity) add(file, ['entity'], 'binding', entity, { entity })
    for (const [name, binding] of Object.entries(route.data)) add(file, ['data', name, 'entity'], 'binding', entity ?? binding.entity, { entity: binding.entity })
    for (const kind of ['params', 'search'] as const) for (const [name, spec] of Object.entries(route[kind])) if (spec.kind === 'id') add(file, [kind, name, 'entity'], 'binding', entity ?? spec.entity, { entity: spec.entity })
    route.uses.forEach((use, i) => { const [target, field] = use.split('.'); add(file, ['uses', String(i)], 'uses', entity ?? target, { entity: target, field }) })
    if (!entity) continue
    add(file, ['title'], 'i18n', entity, { entity }, 'ui:' + route.title)
    route.omit.forEach((field, i) => add(file, ['omit', String(i)], 'layout', entity, { entity, field }))
    function walk(nodes: Node[], path: string[]) {
      nodes.forEach((node, i) => {
        const at = [...path, String(i)]
        if (typeof node === 'string') { add(file, at, route.mode === 'list' ? 'list-column' : 'layout', entity!, { entity: entity!, field: node }); return }
        if ('title' in node && node.title) add(file, [...at, 'title'], 'i18n', entity!, { entity: entity! }, 'ui:' + node.title)
        if (node.kind === 'slot') {
          for (const [prop, spec] of Object.entries(manifest.slots[node.id].props)) {
            if (spec.kind === 'field') {
              add(file, [...at, 'props', prop], 'slot', entity!, { entity: entity!, field: String(node.props[prop]) })
              const registry = sources.entries.find(entry => entry.helper === 'defineSlots')!
              const definition = origin(registry.file, [node.id, 'props', prop])
              references.push({ kind: 'slot', target: { entity: entity!, field: String(node.props[prop]) }, entityContext: entity!,
                owner: `${registry.file}:${node.id}.${prop}`, source: definition.source,
                useSites: [{ owner: file, entityContext: entity!, source: origin(file, [...at, 'props', prop]).source }] })
            }
            if (spec.kind === 'key') add(file, [...at, 'props', prop], 'i18n', entity!, { entity: entity! }, 'ui:' + node.props[prop])
          }
        } else if (node.kind !== 'action') walk(node.children, [...at, 'children'])
      })
    }
    walk(route.layout, ['layout'])
  }
  const nav = sources.entries.find(entry => entry.helper === 'defineNav')
  if (nav) (values[nav.source] as { title: string; target: { entity: string } }[]).forEach((item, i) => {
    add(nav.file, [String(i), 'target', 'entity'], 'nav', item.target.entity, { entity: item.target.entity })
    add(nav.file, [String(i), 'title'], 'i18n', item.target.entity, { entity: item.target.entity }, 'ui:' + item.title)
  })
  return { references, diagnostics }
}

function sourceDiagnostic(error: unknown, fallback: string): ReferenceDiagnostic {
  const file = error instanceof SourceError ? error.location.file : fallback
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { /* Missing/unreadable sources still produce an incomplete-inventory diagnostic. */ }
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const source = error instanceof SourceError ? referenceSource({ '': error.location }, { [file]: tree.text })('') : nodeSpan(tree)
  return { code: 'reference-source', source, message: String(error), repairHint: 'Repair the source error and rerun; this inventory is incomplete.' }
}

/** Capture adapters live outside the pure core. Callers get one common result. */
export async function inventoryInstanceReferences(root: string): Promise<ReferenceInventory> {
  root = resolve(root)
  let input: ReferenceInput
  try {
    const loaded = await loadConfig(resolve(root, 'config.ts'))
    input = { config: loaded.config, access: loaded.authoredAccess, source: referenceSource(loaded.sources, loaded.sourceTexts), catalogs: {}, references: [], diagnostics: [], contracts: [], uncovered: [] }
    const plugins = pluginReferences(root)
    input.references!.push(...plugins.references); input.contracts!.push(...plugins.contracts); input.uncovered!.push(...plugins.uncovered)
    if (existsSync(resolve(root, 'ui'))) {
      try {
        const extracted = await (await import('./vite')).extractUI(root, loaded)
        const console = consoleReferences(extracted.sources, extracted.manifest, extracted.values)
        input.references!.push(...console.references); input.diagnostics!.push(...console.diagnostics)
      } catch (error) { input.diagnostics!.push(sourceDiagnostic(error, resolve(root, 'ui'))) }
    }
    for (const language of loaded.config.languages ?? []) {
      const catalogs: Record<string, { file: string; text: string }> = input.catalogs![language] = {}
      for (const ns of ['domain', 'ui', 'sdk']) {
        const file = resolve(root, 'locales', language, ns + '.json')
        if (existsSync(file)) catalogs[ns] = { file, text: readFileSync(file, 'utf8') }
      }
    }
    // Arbitrary executable code has no complete static dependency contract today.
    // Report that gap on removals instead of claiming that a text scan proved safety.
    const codeFiles = (directory: string): string[] => !existsSync(directory) ? [] : readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new SourceError({ file, line: 1, column: 1 }, 'Cannot classify a linked Instance source')
      return entry.isDirectory() ? codeFiles(file) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : []
    }).sort()
    for (const file of [...codeFiles(resolve(root, 'server')), ...codeFiles(resolve(root, 'src'))]) input.uncovered!.push({ code: 'opaque-instance-code', kind: 'instance-code', source: nodeSpan(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)),
      message: 'Instance code requires a scoped target typecheck and explicit dependency review before removal.', repairHint: 'Repair declared/typed dependencies in this file and run the Instance typecheck against the intended target.' })
    const inventory = referenceInventory(input)
    inventory.diagnostics = referenceDiagnostics(input, inventory)
    return inventory
  } catch (error) {
    return { references: [], contracts: [], uncovered: [], diagnostics: [sourceDiagnostic(error, resolve(root, 'config.ts'))] }
  }
}
export async function validateInstanceReferences(root: string, intent?: RemovalIntent) {
  const inventory = await inventoryInstanceReferences(root)
  const result = intent ? validateRemoval(inventory, intent) : { ok: inventory.diagnostics.length === 0, diagnostics: inventory.diagnostics }
  return { ...result, inventory }
}
