import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { CommandDefinition } from './commands'
import type { ConsoleNavigation, ConsolePageAction } from './console-contract'
import { isAccountAccessCommand } from './account-command'
import type { KernelRegistry } from './kernel/registry'
import type { Scope } from './types'
import type { ConsoleWidget, ConsoleDetailItem, ConsoleEntityDisplay, ConsoleFieldDisplay, ConsoleGrant, ConsoleModelUI, ConsoleRegistry } from './console-contract'
import type { ConsoleAuthorization } from './console-authorization'
import type { ListConfig } from './list-contract'
import { configuredList } from './query/list-views'

const safeGrant = (grant: ConsoleGrant): ConsoleGrant => typeof grant === 'string' ? grant : pick(grant, ['entity', 'operation'])

function pick<T, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]])) as Pick<T, K>
}


/** Match the existing collection menu's placement and row-binding rules. */
export function consoleCollectionCommand(config: InstanceConfig, command: CommandDefinition<any>, entity?: string): Record<string, any> | undefined {
  if ('system' in command.permission || isAccountAccessCommand(config, command.name)) return undefined
  const destination = entity ?? command.ui?.placement?.entity ?? command.permission.entity
  if (!config.entities[destination] || command.ui?.placement?.entity !== destination && command.permission.entity !== destination) return undefined
  // Legacy account actions also belong exclusively to Application access.
  if (Object.values(config.entities[destination].fields).some(field => field.userLink)
    && ['link_account', 'remove_access'].some(action => command.name === `${destination}/${action}`)) return undefined
  let schema: Record<string, any>
  try { schema = z.toJSONSchema(command.input, { io: 'input' }); z.fromJSONSchema(schema as any) } catch { return undefined }
  if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object'
    || schema.anyOf || schema.oneOf || schema.allOf || schema.$ref || schema.patternProperties) return undefined
  const fields = Object.values(schema.properties) as Record<string, any>[]
  const spec = (field: Record<string, any>) => field.anyOf?.find((item: Record<string, any>) => item.type !== 'null') ?? field
  if (fields.some(field => !['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(
    Array.isArray(spec(field).type) ? spec(field).type.find((type: string) => type !== 'null') : spec(field).type))) return undefined
  if (fields.filter(field => field.type === 'string' && field.referenceEntity === destination).length === 1) return undefined
  return schema
}
export function consoleCommandCreates(command: CommandDefinition<any>, entity: string) {
  return command.ui?.placement?.entity === entity && command.ui.placement.action === 'create'
    || command.ui?.replacesCrud === 'create' || !('system' in command.permission) && command.permission.operation === 'create'
}

/** Reused by the provider and the final core boundary; captions follow this result only. */
export function consolePageActions(kernel: KernelRegistry, actions: readonly ConsolePageAction[], navigation: readonly ConsoleNavigation[], authority: ConsoleAuthorization): ConsolePageAction[] {
  const config = kernel.config
  const requiredInputs = (schema: Record<string, any>): boolean => {
    const visited = new Set<object>()
    const allowed = (node: any): boolean => {
      if (typeof node === 'boolean') return node
      if (!node || typeof node !== 'object') return false
      if (Array.isArray(node)) return node.every(allowed)
      if (visited.has(node)) return true
      visited.add(node)
      if (!authority.schema(node) || node.readOnly || node['x-ui']?.hidden) return false
      if (node.$ref) {
        // Zod accepts local JSON pointers, including recursive definitions.
        if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#')) return false
        let target: any = schema
        try {
          const pointer = decodeURIComponent(node.$ref.slice(1))
          if (pointer && !pointer.startsWith('/')) return false
          for (const part of pointer ? pointer.slice(1).split('/') : []) {
            if (/~[^01]|~$/.test(part)) return false
            const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
            if (!target || !Object.hasOwn(target, key)) return false
            target = target[key]
          }
        } catch { return false }
        if (!allowed(target)) return false
      }
      // Inspect every accepted schema dependency, not literal/annotation objects.
      return ['anyOf', 'oneOf', 'allOf', 'prefixItems', 'items', 'additionalItems', 'contains', 'additionalProperties', 'propertyNames']
        .every(key => !node[key] || allowed(node[key]))
        && Object.values(node.patternProperties ?? {}).every(allowed)
        && (node.required ?? []).every((name: string) => node.properties?.[name] && allowed(node.properties[name]))
    }
    return allowed(schema)
  }
  const commandAllowed = (command: CommandDefinition<any>, entity: string) => {
    const schema = consoleCollectionCommand(config, command, entity)
    return config.commands.includes(command.name) && authority.canRead(entity) && authority.command(command.name)
      && !!schema && requiredInputs(schema) && !(command.ui?.replacesCrud && authority.operation(entity, command.ui.replacesCrud))
  }
  const creates = (entity: string) => [...kernel.commands.values()].find(command => commandAllowed(command, entity) && consoleCommandCreates(command, entity))
  return actions.flatMap(action => {
    if (!action || !action.target) return []
    let target: ConsolePageAction['target'] | undefined
    const reference = action.target
    if ('navigation' in reference && navigation.some(item => item.id === reference.navigation)) target = { navigation: reference.navigation }
    if ('create' in action.target) {
      const entity = action.target.create
      if (authority.canRead(entity)) {
        if (authority.operation(entity, 'create')) {
          const definition = config.entities[entity]
          const explicit = config.ui?.entities?.[entity]?.form?.create?.fields
          const available = Object.entries(definition.fields).every(([field, spec]) => !spec.required || spec.readOnly || spec.default !== undefined
            || authority.write(entity, field, 'create') && !spec.ui?.hidden && (!explicit || explicit.includes(field))
              && (spec.type !== 'ref' || !!spec.entity && authority.canRead(spec.entity)))
          if (available) target = { create: entity }
        } else {
          const command = creates(entity)
          if (command) target = { command: command.name }
        }
      }
    }
    if ('command' in action.target) {
      const command = kernel.commands.get(action.target.command)
      if (command && !('system' in command.permission)) {
        const entity = command.ui?.placement?.entity ?? command.permission.entity
        if (commandAllowed(command, entity) && (!consoleCommandCreates(command, entity)
          || !authority.operation(entity, 'create') && creates(entity)?.name === command.name)) target = { command: command.name }
      }
    }
    return target ? [{ ...pick(action, ['id', 'label', 'description', 'icon', 'primary']), target }] : []
  })
}

/** Exact membership only; callers supply normalized (and, at projection, granted) views. */
export function consoleWidgetDrilldown(widget: ConsoleWidget, views: ListConfig['views']): ConsoleWidget['drilldown'] {
  const target = widget.drilldown
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).length !== 1
    || typeof target.view !== 'string' || !target.view) return undefined
  const query = widget.query
  if ('search' in query && query.search !== undefined || 'labelWhere' in query && query.labelWhere !== undefined
    || ['view', 'rowAccess', 'contextList'].some(key => key in query && (query as unknown as Record<string, unknown>)[key] !== undefined)) return undefined
  const view = views?.find(view => view.id === target.view)
  if (!view || view.rowAccess) return undefined
  function equal(left: unknown, right: unknown): boolean {
    if (left === right) return true
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => equal(value, right[index]))
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
  }
  return equal(query.where ?? {}, view.where) ? { view: view.id } : undefined
}

/** Project every copy of presentation data through the same live authority.
 * Drop predicates as a whole: pruning Boolean operands would change their meaning. */
export function consolePresentation(kernel: KernelRegistry, scope: Scope, authority: ConsoleAuthorization) {
  const config = kernel.config
  const { canRead, read, write, literals, relation, predicate } = authority
  function fieldUI<T extends ConsoleFieldDisplay>(entity: string, ui: T): T {
    const signedBy = ui.signedBy
    return { ...pick(ui, ['hidden', 'kind', 'span', 'section']),
      ...('format' in ui && ui.format === 'identifier' ? { format: 'identifier' } : {}),
      ...(signedBy && literals(entity, signedBy.field) ? { signedBy: pick(signedBy, ['field', 'negativeValue']) } : {}) } as T
  }
  function display(entity: string, source: ConsoleEntityDisplay): ConsoleEntityDisplay {
    const readable = (field: string) => read(entity, field)
    const operand = (field: string) => literals(entity, field)
    const fields = (values: string[]) => values.filter(readable)
    const itemAllowed = (item: ConsoleDetailItem) => typeof item === 'string' ? readable(item) : readable(item.field) && (!item.when || operand(item.when.field))
    const detailItems = (items: ConsoleDetailItem[]) => items.filter(itemAllowed).map(item => typeof item === 'string' ? item : {
      ...pick(item, ['field', 'label', 'help']), ...(item.when ? { when: pick(item.when, ['field', 'eq']) } : {}),
    })
    const result: ConsoleEntityDisplay = {}
    if (source.lookup !== undefined) result.lookup = source.lookup
    if (source.fields) result.fields = Object.fromEntries(Object.entries(source.fields).filter(([field]) => readable(field)).map(([field, ui]) => [field, fieldUI(entity, ui)]))
    if (source.views) result.views = source.views.filter(view => [view.startField, view.endField, view.titleField, ...view.titleFields ?? [], view.secondaryField].every(field => !field || readable(field))).map(view => pick(view, ['kind', 'startField', 'endField', 'titleField', 'titleFields', 'secondaryField']))
    if (source.list) {
      const list = source.list
      const relatedColumns = Object.fromEntries(Object.entries(list.relatedColumns ?? {}).filter(([, column]) => {
        const target = config.entities[entity].fields[column.via]?.entity
        const end = target && config.entities[target]?.fields[column.field]?.entity
        return readable(column.via) && target && read(target, column.field) && end && read(end, 'id')
      }).map(([key, column]) => [key, pick(column, ['via', 'field'])]))
      const column = (field: string) => readable(field) || Object.hasOwn(relatedColumns, field)
      const literalColumn = (field: string) => {
        const related = relatedColumns[field]
        if (!related) return operand(field)
        const target = config.entities[entity].fields[related.via].entity!
        return operand(related.via) && authority.label(target, related.field)
      }
      result.list = {
        ...pick(list, ['pageSize', 'compact', 'mobileCards']),
        ...(list.defaultSort && operand(list.defaultSort.key) ? { defaultSort: pick(list.defaultSort, ['key', 'direction']) } : {}),
        ...(list.relatedColumns ? { relatedColumns } : {}),
        ...(list.columns ? { columns: list.columns.filter(spec => column(spec.field)).map(spec => ({
          ...pick(spec, ['field', 'label', 'defaultVisible']),
          ...(spec.secondary && column(spec.secondary) ? { secondary: spec.secondary } : {}),
          ...(spec.cell ? { cell: spec.cell.kind === 'badge' && !literalColumn(spec.field) ? { kind: 'badge' as const } : structuredClone(spec.cell) } : {}),
        })) } : {}),
        ...(list.search ? { search: list.search.filter(operand) } : {}),
        ...(list.filter ? { filter: Object.fromEntries(Object.entries(list.filter).filter(([field]) => literalColumn(field)).map(([field, hint]) => [field, structuredClone(hint)])) } : {}),
        ...(list.sort ? { sort: Object.fromEntries(Object.entries(list.sort).filter(([field, hint]) => operand(field) && (!hint || hint.fields.every(operand))).map(([field, hint]) => [field, hint && { fields: [...hint.fields] }])) } : {}),
        ...(list.rowAccess !== undefined && authority.listRowAccess(entity) ? { rowAccess: structuredClone(list.rowAccess) } : {}),
        ...(list.views ? { views: list.views.filter(view => predicate(entity, view.where) && (!view.rowAccess || authority.listRowAccess(entity))).map(view => structuredClone(pick(view, ['id', 'label', 'where', 'rowAccess', 'default']))) } : {}),
      }
      if (list.defaultSort && (!operand(list.defaultSort.key) || list.sort?.[list.defaultSort.key] && !result.list.sort?.[list.defaultSort.key])) delete result.list.defaultSort
    }
    if (source.form) result.form = Object.fromEntries(Object.entries(source.form).flatMap(([key, form]) => {
      if (key !== 'create' && key !== 'edit') return []
      const operation = key === 'create' ? 'create' : 'update'
      return authority.operation(entity, operation) ? [[key, { fields: form.fields.filter(field => {
        const through = relation(entity, field)?.through
        return write(entity, field, operation) || through && [through.createCommand, through.deleteCommand].every(authority.command)
      }) }]] : []
    }))
    if (source.sections) result.sections = source.sections.map(section => ({ ...pick(section, ['id', 'label']), fields: section.fields.filter(field => readable(field) || !!relation(entity, field)?.through) })).filter(section => section.fields.length)
    if (source.detail) {
      const detail = source.detail
      const lists = Object.fromEntries(Object.entries(detail.lists ?? {}).filter(([, list]) => read(entity, 'id') && read(list.entity, list.bind.field)).map(([key, list]) => [key, {
        ...pick(list, ['entity', 'label']), bind: pick(list.bind, ['field', 'record']), ...(list.columns ? { columns: list.columns.filter(field => read(list.entity, field)) } : {}),
        ...(list.create !== undefined ? { create: list.create && write(list.entity, list.bind.field, 'create') } : {}),
      }]))
      const relations = Object.fromEntries(Object.entries(detail.relations ?? {}).flatMap(([key, hint]) => {
        const target = relation(entity, key)?.entity
        if (!target) return []
        const defaultSort = hint.defaultSort
        return [[key, { columns: hint.columns.filter(field => read(target, field)), ...(defaultSort && literals(target, defaultSort.key) ? { defaultSort: pick(defaultSort, ['key', 'direction']) } : {}) }]]
      }))
      const card = (key: string) => Object.hasOwn(lists, key) || !!relation(entity, key)
      result.detail = {
        ...(detail.inlineEdit !== undefined && authority.operation(entity, 'update') ? { inlineEdit: detail.inlineEdit } : {}),
        ...(detail.lists ? { lists } : {}),
        ...(detail.relations ? { relations } : {}),
        ...(detail.fields ? { fields: fields(detail.fields) } : {}),
        ...(detail.summary ? { summary: detailItems(detail.summary) } : {}),
        ...(detail.groups ? { groups: detail.groups.map(group => ({ ...pick(group, ['id', 'label', 'help']), fields: detailItems(group.fields) })).filter(group => group.fields.length) } : {}),
        ...(detail.metrics ? { metrics: detail.metrics.filter(metric => readable(metric.field) && (!metric.unitField || readable(metric.unitField))).map(metric => pick(metric, ['field', 'unitField', 'tone'])) } : {}),
        ...(detail.sections ? { sections: detail.sections.map(section => section.row ? { row: section.row.filter(card) } : { fields: 'info' as const }).filter(section => !section.row || section.row.length) } : {}),
      }
    }
    return result
  }
  const permits = authority.grant
  function modelUI(source: ConsoleModelUI): ConsoleModelUI {
    const entities = Object.fromEntries(Object.entries(source.entities ?? {}).filter(([entity]) => canRead(entity)).map(([entity, hints]) => [entity, display(entity, hints)]))
    const navigation = source.navigation
    const items = navigation?.items.filter(item => canRead(item.entity) && !item.hidden && (!item.roles || item.roles.includes(scope.role))
      && (!item.view || entities[item.entity]?.list?.views?.some(view => view.id === item.view)))
    return {
      ...(source.defaultLanguage ? { defaultLanguage: source.defaultLanguage } : {}),
      ...(source.entities ? { entities } : {}),
      ...(navigation ? { navigation: { ...(navigation.routes ? { routes: navigation.routes.map(route => pick(route, ['id', 'icon', 'order'])) } : {}),
        items: items!.map(item => pick(item, ['id', 'entity', 'label', 'icon', 'group', 'order', 'roles', 'view', 'hidden'])),
        groups: navigation.groups.filter(group => items!.some(item => item.group === group.id)).map(group => pick(group, ['id', 'label', 'order', 'icon'])) } } : {}),
    }
  }
  function registry(source: ConsoleRegistry): ConsoleRegistry {
    const entities = Object.fromEntries(Object.entries(source.entities).filter(([entity]) => canRead(entity)).map(([entity, hints]) => [entity, display(entity, hints)]))
    const pages = source.pages.filter(page => permits(page.grant)).flatMap(page => {
      const safePage = { ...pick(page, ['id', 'label', 'path', 'renderer']), ...(page.grant ? { grant: safeGrant(page.grant) } : {}) }
      if (!page.widgets) return [safePage]
      const widgets = page.widgets.flatMap((widget): ConsoleWidget[] => {
        if (!canRead(widget.query.entity)) return []
        const input = widget.kind === 'stat' ? { ...widget.query, select: widget.aggregate.fn === 'sum' ? ['id', widget.aggregate.field] : ['id'], limit: 1 } : widget.query
        const query = authority.query(input)
        if (!query || query.include || query.cursor || 'contextList' in input) return []
        const fieldAllowed = (field: string) => !!query.select?.includes(field) && read(query.entity, field)
          || !!query.labels?.includes(field) && authority.label(query.entity, field)
        // Resolve explicit destination views as list queries do, under this live authority.
        const views = configuredList(kernel, query.entity)?.views?.filter(view => predicate(query.entity, view.where))
        const drilldown = consoleWidgetDrilldown(widget, views)
        const common = { ...pick(widget, ['id', 'label']), ...(drilldown ? { drilldown } : {}) }
        if (widget.kind === 'stat') return [{ ...common, kind: 'stat', query: pick(query, ['entity', 'where']),
          aggregate: widget.aggregate.fn === 'count' ? { fn: 'count' } : { fn: 'sum', field: widget.aggregate.field } }]
        const safeQuery = { ...pick(query, ['entity', 'where', 'limit', 'select', 'labels', 'search', 'labelWhere', 'orderBy']), select: query.select! }
        if (widget.kind === 'table' && widget.columns.every(fieldAllowed)) return [{ ...common, kind: 'table', query: safeQuery, columns: [...widget.columns] }]
        if (widget.kind === 'list' && fieldAllowed(widget.field)) return [{ ...common, kind: 'list', query: safeQuery, field: widget.field }]
        return []
      })
      return widgets.length ? [{ ...safePage, widgets, ...(page.sections ? { sections: page.sections.map(section => ({ row: section.row.filter(id => widgets.some(widget => widget.id === id)) })).filter(section => section.row.length) } : {}) }] : []
    })
    const result: ConsoleRegistry = {
      entities, pages,
      navigation: source.navigation.filter(item => (scope.role !== 'member' || item.placement === 'sidebar' && !!item.entity) && !!item.page !== !!item.entity && permits(item.grant) && (!item.roles || item.roles.includes(scope.role)) && (!item.page || pages.some(page => page.id === item.page))
        && (!item.entity || canRead(item.entity) && (!item.view || entities[item.entity]?.list?.views?.some(view => view.id === item.view)))).map(item => ({ ...pick(item, ['id', 'placement', 'label', 'icon', 'order', 'roles', 'page', 'entity', 'view']),
          ...(item.grant ? { grant: safeGrant(item.grant) } : {}),
          ...(item.group ? { group: pick(item.group, ['id', 'label', 'order', 'icon']) } : {}) })),
      ...(source.modelUi ? { modelUi: modelUI(source.modelUi) } : {}),
    }
    result.pages = result.pages.map(page => {
      const sourcePage = source.pages.find(candidate => candidate.id === page.id)!
      return sourcePage.actions === undefined ? page : { ...page, actions: consolePageActions(kernel, sourcePage.actions, result.navigation, authority) }
    })
    return result
  }
  return { fieldUI, display, modelUI, registry }
}
