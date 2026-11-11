import type { KernelRegistry } from './kernel/registry'
import type { Scope } from './types'
import type { ConsoleWidget, ConsoleDetailItem, ConsoleEntityDisplay, ConsoleFieldDisplay, ConsoleGrant, ConsoleModelUI, ConsoleRegistry } from './console-contract'
import type { ConsoleAuthorization } from './console-authorization'

const safeGrant = (grant: ConsoleGrant): ConsoleGrant => typeof grant === 'string' ? grant : pick(grant, ['entity', 'operation'])

function pick<T, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]])) as Pick<T, K>
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
      result.list = {
        ...pick(list, ['pageSize', 'compact', 'mobileCards']),
        ...(list.defaultSort && operand(list.defaultSort.key) ? { defaultSort: pick(list.defaultSort, ['key', 'direction']) } : {}),
        ...(list.relatedColumns ? { relatedColumns } : {}),
        ...(list.columns ? { columns: list.columns.filter(column) } : {}),
        ...(list.search ? { search: list.search.filter(operand) } : {}),
        ...(list.filter ? { filter: Object.fromEntries(Object.entries(list.filter).filter(([field]) => operand(field))) } : {}),
        ...(list.sort ? { sort: Object.fromEntries(Object.entries(list.sort).filter(([field, hint]) => operand(field) && (!hint || hint.fields.every(operand))).map(([field, hint]) => [field, hint && { fields: [...hint.fields] }])) } : {}),
        ...(list.views ? { views: list.views.filter(view => predicate(entity, view.where)).map(view => pick(view, ['id', 'label', 'where', 'default'])) } : {}),
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
        const common = pick(widget, ['id', 'label'])
        if (widget.kind === 'stat') return [{ ...common, kind: 'stat', query: pick(query, ['entity', 'where']),
          aggregate: widget.aggregate.fn === 'count' ? { fn: 'count' } : { fn: 'sum', field: widget.aggregate.field } }]
        const safeQuery = { ...pick(query, ['entity', 'where', 'limit', 'select', 'labels', 'search', 'labelWhere', 'orderBy']), select: query.select! }
        if (widget.kind === 'table' && widget.columns.every(fieldAllowed)) return [{ ...common, kind: 'table', query: safeQuery, columns: [...widget.columns] }]
        if (widget.kind === 'list' && fieldAllowed(widget.field)) return [{ ...common, kind: 'list', query: safeQuery, field: widget.field }]
        return []
      })
      return widgets.length ? [{ ...safePage, widgets, ...(page.sections ? { sections: page.sections.map(section => ({ row: section.row.filter(id => widgets.some(widget => widget.id === id)) })).filter(section => section.row.length) } : {}) }] : []
    })
    return {
      entities, pages,
      navigation: source.navigation.filter(item => (scope.role !== 'member' || item.placement === 'sidebar' && !!item.entity) && !!item.page !== !!item.entity && permits(item.grant) && (!item.roles || item.roles.includes(scope.role)) && (!item.page || pages.some(page => page.id === item.page))
        && (!item.entity || canRead(item.entity) && (!item.view || entities[item.entity]?.list?.views?.some(view => view.id === item.view)))).map(item => ({ ...pick(item, ['id', 'placement', 'label', 'icon', 'order', 'roles', 'page', 'entity', 'view']),
          ...(item.grant ? { grant: safeGrant(item.grant) } : {}),
          ...(item.group ? { group: pick(item.group, ['id', 'label', 'order', 'icon']) } : {}) })),
      ...(source.modelUi ? { modelUi: modelUI(source.modelUi) } : {}),
    }
  }
  return { fieldUI, display, modelUI, registry }
}
