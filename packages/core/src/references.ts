/** Build-time only. Pure inventory/validation over a captured graph; no I/O or edits. */
import ts from 'typescript'
import type { InstanceConfig } from './config'
import { baseFields } from './config'
import { compileAccess, type AccessInput, type EntityAccess } from './access'
import { expressionInfo, isExpression } from './query/expressions'
import { DeclarationError } from './schema/declaration'

export interface ReferenceSpan { file: string; start: number; end: number; line: number; column: number; endLine: number; endColumn: number }
export type ReferenceKind = 'relation' | 'display' | 'computed' | 'constraint' | 'policy' | 'predicate' | 'mask' | 'action-condition'
  | 'layout' | 'list-column' | 'nav' | 'uses' | 'binding' | 'slot' | 'i18n' | 'plugin' | 'instance-code'
export interface ReferenceTarget { entity: string; field?: string }
export interface ReferenceUse { owner: string; entityContext: string; source: ReferenceSpan }
export interface Reference {
  kind: ReferenceKind; target: ReferenceTarget; entityContext: string; source: ReferenceSpan; owner: string; useSites: ReferenceUse[]
  key?: string; language?: string
}
export interface ReferenceDiagnostic {
  code: string; message: string; source: ReferenceSpan; repairHint: string
  kind?: ReferenceKind; target?: ReferenceTarget; owner?: string; useSites?: ReferenceUse[]
}
/** Contract dependencies deliberately have no entity/field target. */
export interface PluginContract { plugin: string; contract: string; range: string; optional: boolean; source: ReferenceSpan }
export interface ReferenceInventory { references: Reference[]; contracts: PluginContract[]; diagnostics: ReferenceDiagnostic[]; uncovered: ReferenceDiagnostic[] }
export interface ReferenceInput {
  config: InstanceConfig
  source(path: string): ReferenceSpan
  access?: { shared?: AccessInput; entities: Record<string, EntityAccess | undefined> }
  references?: Reference[]; contracts?: PluginContract[]; diagnostics?: ReferenceDiagnostic[]
  uncovered?: ReferenceDiagnostic[]
  catalogs?: Record<string, Record<string, { file: string; text: string }>>
}
export type RemovalIntent = { kind: 'remove_field'; entity: string; field: string } | { kind: 'remove_entity'; entity: string }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const identity = (value: unknown) => JSON.stringify(value)
export function nodeSpan(node: ts.Node): ReferenceSpan {
  const tree = node.getSourceFile(), start = node.getStart(tree), end = node.getEnd()
  const a = tree.getLineAndCharacterOfPosition(start), b = tree.getLineAndCharacterOfPosition(end)
  return { file: tree.fileName, start, end, line: a.line + 1, column: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 }
}
/** Exact authored token at a canonical loader location, never a text search. */
export function referenceSource(sources: Record<string, { file: string; line: number; column: number }>, texts: Record<string, string>) {
  const trees = new Map<string, ts.SourceFile>()
  return (path: string): ReferenceSpan => {
    while (!sources[path] && path) path = path.split('.').slice(0, -1).join('.')
    const location = sources[path] ?? sources['']
    if (!location) throw new Error('Reference source map has no root')
    let tree = trees.get(location.file)
    if (!tree) { tree = ts.createSourceFile(location.file, texts[location.file] ?? '', ts.ScriptTarget.Latest, true); trees.set(location.file, tree) }
    const offset = tree.getPositionOfLineAndCharacter(location.line - 1, location.column - 1)
    let match: ts.Node = tree
    function visit(node: ts.Node) {
      if (node.getStart(tree) <= offset && node.end > offset) { match = node; ts.forEachChild(node, visit) }
    }
    visit(tree)
    return nodeSpan(match)
  }
}
const repair: Record<ReferenceKind, string> = {
  relation: 'Repair or remove the referencing relation/ref declaration explicitly.',
  display: 'Choose a surviving display field or repair the display expression.',
  computed: 'Repair or remove the dependent computed expression explicitly.',
  constraint: 'Repair the dependent schema constraint explicitly.',
  policy: 'Repair the access rule explicitly and review its authorization behavior.',
  predicate: 'Repair the named predicate and review every listed entity context and use site.',
  mask: 'Repair the explicitly authored read mask.',
  'action-condition': 'Repair the action availability condition explicitly.',
  layout: 'Remove or replace this layout/omit reference explicitly.',
  'list-column': 'Remove or replace this list column explicitly.',
  nav: 'Remove or retarget this navigation entry explicitly.',
  uses: 'Repair the custom page uses declaration and its component together.',
  binding: 'Repair this page data/parameter binding explicitly.',
  slot: 'Supply a surviving field of the declared type or repair the slot contract and all consumers.',
  i18n: 'Repair the dictionary key and all consumers in every configured language and plural form.',
  plugin: 'Repair the declared plugin schema requirement; do not change contract requires names.',
  'instance-code': 'Repair Instance code explicitly and run its scoped typecheck.',
}
export function referenceInventory(input: ReferenceInput): ReferenceInventory {
  const { config, source } = input
  const references = [...input.references ?? []], diagnostics = [...input.diagnostics ?? []]
  const contracts = [...input.contracts ?? []]
  const uncovered = [...input.uncovered ?? []]
  const add = (kind: ReferenceKind, entityContext: string, target: ReferenceTarget, path: string, uses: ReferenceUse[] = []) => {
    references.push({ kind, target, entityContext, owner: path, source: source(path), useSites: uses })
  }
  for (const plugin of config.plugins ?? []) {
    const root = `plugins.${plugin.name}`
    if (!plugin.schemaReferences) uncovered.push({ code: 'opaque-plugin-reference', kind: 'plugin', source: source(root),
      message: `Plugin ${plugin.name} has no declared schema reference inventory.`, repairHint: 'Declare schemaReferences and review the plugin executable dependencies.' })
    for (const [i, target] of (plugin.schemaReferences ?? []).entries()) add('plugin', target.entity, target, `${root}.schemaReferences.${i}`)
    for (const [optional, requirements] of [[false, plugin.requires], [true, plugin.optionalRequires]] as const) for (const [contract, range] of Object.entries(requirements ?? {})) {
      contracts.push({ plugin: plugin.name, contract, range, optional, source: source(`${root}.${optional ? 'optionalRequires' : 'requires'}.${contract}`) })
    }
  }
  for (const [entity, spec] of Object.entries(config.entities)) {
    const root = `entities.${entity}`
    for (const [field, f] of Object.entries(spec.fields)) {
      const path = `${root}.fields.${field}`
      if (f.type === 'ref' && f.entity) add('relation', entity, { entity: f.entity }, `${path}.entity`)
      if (f.computed) expression('computed', field, f.computed, `${path}.computed`)
      if (f.backfillFrom) {
        add('computed', entity, { entity, field: f.backfillFrom.refField }, `${path}.backfillFrom.refField`)
        const target = spec.fields[f.backfillFrom.refField]?.entity
        if (target) add('computed', entity, { entity: target, field: f.backfillFrom.valueField }, `${path}.backfillFrom.valueField`)
      }
      if (f.ui?.signedBy) add('constraint', entity, { entity, field: f.ui.signedBy.field }, `${path}.ui.signedBy.field`)
    }
    for (const [name, relation] of Object.entries(spec.relations)) {
      const path = `${root}.relations.${name}`
      add('relation', entity, { entity: relation.entity }, `${path}.entity`)
      add('relation', entity, { entity: relation.many ? relation.entity : entity, field: relation.field }, `${path}.field`)
      if (relation.through) {
        add('relation', entity, { entity: relation.through.entity }, `${path}.through.entity`)
        add('relation', entity, { entity: relation.through.entity, field: relation.through.field }, `${path}.through.field`)
      }
    }
    spec.checks.forEach((check, i) => { for (const key of ['left', 'right'] as const) add('constraint', entity, { entity, field: check[key] }, `${root}.checks.${i}.${key}`) })
    if (spec.displayExpression) expression('display', 'computed_display', spec.displayExpression, `${root}.displayField`)
    else if (spec.displayField) {
      if (isExpression(spec.displayField)) expression('display', 'computed_display', spec.displayField, `${root}.displayField`)
      else add('display', entity, { entity, field: spec.displayField }, `${root}.displayField`)
    }
    function expression(kind: 'display' | 'computed', field: string, wire: string, path: string) {
      try {
        const info = expressionInfo(config, entity, field, wire)
        for (const dep of info.dependencies) {
          for (const hop of dep.hops) { add(kind, entity, { entity: hop.source, field: hop.field }, path); add(kind, entity, { entity: hop.target }, path) }
          add(kind, entity, { entity: dep.entity, field: dep.field }, path)
        }
        for (const table of info.tables.keys()) add(kind, entity, { entity: table }, path)
      } catch (error) { diagnostics.push({ code: 'reference-expression', source: source(path), message: String(error), repairHint: repair[kind] }) }
    }
  }
  if (input.access?.shared) {
    try {
      const used = new Set<string>()
      const policy = compileAccess(config, input.access.entities, input.access.shared, ref => {
        if (ref.source.startsWith('access.predicates.')) used.add(ref.source.split('.')[2])
        for (const use of ref.useSites) if (use.startsWith('access.predicates.')) used.add(use.split('.')[2])
        add(ref.kind, ref.entityContext, { entity: ref.entity, ...(ref.field ? { field: ref.field } : {}) }, ref.source,
          ref.useSites.map(path => ({ owner: path, entityContext: ref.entityContext, source: source(path) })))
      })
      for (const rule of policy.entities) if (config.entities[rule.entity]) add('policy', rule.entity, { entity: rule.entity }, rule.source)
      for (const name of Object.keys(input.access.shared.predicates)) if (!used.has(name)) uncovered.push({ code: 'unbound-predicate',
        source: source(`access.predicates.${name}`), message: `Predicate ${name} has no entity context. Its field targets cannot be inferred.`, repairHint: 'Remove the unused predicate or give it an explicit use in an entity context.' })
    } catch (error) { diagnostics.push({ code: 'reference-access', source: source(error instanceof DeclarationError ? error.path.join('.') : 'access'), message: String(error), repairHint: repair.policy }) }
  }
  for (const language of config.languages ?? []) for (const [namespace, catalog] of Object.entries(input.catalogs?.[language] ?? {})) {
    const tree = ts.createSourceFile(catalog.file, catalog.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSON)
    const object = tree.statements[0] && ts.isExpressionStatement(tree.statements[0]) ? tree.statements[0].expression : undefined
    if (!object || !ts.isObjectLiteralExpression(object) || (tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
      diagnostics.push({ code: 'reference-catalog', source: nodeSpan(tree), message: 'Invalid dictionary JSON', repairHint: 'Provide a flat JSON string catalog.' }); continue
    }
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue
      const key = property.name.text
      let target: ReferenceTarget | undefined
      if (namespace === 'domain') {
        const exact = key.split('.')
        const exactTarget = exact[0] === 'entity' ? config.entities[exact[1]] : config.entities[exact[1]]?.fields[exact[2]]
        const parts = (exactTarget ? key : key.replace(/_(zero|one|two|few|many|other)$/, '')).split('.')
        if (parts[0] === 'entity' && parts.length === 2) target = { entity: parts[1] }
        if (['field', 'enum'].includes(parts[0]) && parts.length >= 3) target = { entity: parts[1], field: parts[2] }
      }
      if (target) references.push({ kind: 'i18n', target, entityContext: target.entity, source: nodeSpan(property.name), owner: `${catalog.file}:${key}`, key, language, useSites: [] })
      // UI keys can be shared by pages/slots in different entity contexts. Keep all consumers.
      const uiKey = (input.references ?? []).some(use => use.key === `ui:${key}`) ? key : key.replace(/_(zero|one|two|few|many|other)$/, '')
      if (namespace === 'ui') for (const use of input.references ?? []) if (use.key === `ui:${uiKey}`) {
        references.push({ ...use, kind: 'i18n', source: nodeSpan(property.name), owner: `${catalog.file}:${key}`, key, language,
          useSites: [...use.useSites, { owner: use.owner, entityContext: use.entityContext, source: use.source }] })
      }
    }
  }
  const grouped = new Map<string, Reference>()
  for (const ref of references) {
    const key = identity([ref.kind, ref.target.entity, ref.target.field ?? null, ref.entityContext, ref.source, ref.owner, ref.key, ref.language])
    const previous = grouped.get(key)
    grouped.set(key, { ...ref, useSites: [...previous?.useSites ?? [], ...ref.useSites] })
  }
  const stable = <T>(items: T[]) => [...new Map(items.map(item => [identity(item), item])).entries()].sort(([a], [b]) => compare(a, b)).map(([, item]) => item)
  return { references: [...grouped.entries()].sort(([a], [b]) => compare(a, b)).map(([, ref]) => ({ ...ref, useSites: stable(ref.useSites) })),
    contracts: stable(contracts), diagnostics: stable(diagnostics), uncovered: stable(uncovered) }
}
export function validateRemoval(inventory: ReferenceInventory, intent: RemovalIntent) {
  const blockers = inventory.references.filter(ref => {
    if (ref.target.entity !== intent.entity || intent.kind === 'remove_field' && ref.target.field !== intent.field) return false
    // The removed entity declaration owns these structural references. External
    // presentation, dictionary, plugin, code and authorization sources survive.
    return !(intent.kind === 'remove_entity' && ref.owner.startsWith(`entities.${intent.entity}.`)
      && ['relation', 'display', 'computed', 'constraint'].includes(ref.kind))
  })
  const diagnostics: ReferenceDiagnostic[] = [...inventory.diagnostics, ...inventory.uncovered, ...blockers.map(ref => ({
    code: 'removal-reference', kind: ref.kind, target: ref.target, owner: ref.owner, source: ref.source, useSites: ref.useSites,
    message: `${intent.kind} ${intent.entity}${intent.kind === 'remove_field' ? '.' + intent.field : ''} is blocked by ${ref.kind}: ${ref.owner}`,
    repairHint: repair[ref.kind],
  }))]
  return { ok: diagnostics.length === 0, diagnostics }
}
/** Validate reference targets independently from loader fail-fast semantics. */
export function referenceDiagnostics(input: ReferenceInput, inventory = referenceInventory(input)): ReferenceDiagnostic[] {
  return [...inventory.diagnostics, ...inventory.references.flatMap(ref => {
    const spec = input.config.entities[ref.target.entity]
    return !spec || ref.target.field && !baseFields.includes(ref.target.field) && !Object.hasOwn(spec.fields, ref.target.field)
      ? [{ code: 'unknown-reference', kind: ref.kind, target: ref.target, source: ref.source, owner: ref.owner, useSites: ref.useSites,
        message: `Unknown reference ${ref.target.entity}${ref.target.field ? '.' + ref.target.field : ''}`, repairHint: repair[ref.kind] }] : []
  })]
}
