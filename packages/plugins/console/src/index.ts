import { versionHistory, type ConfigVersion } from '@workbasehq/core/migrations/versions'
import { validateQuery } from '@workbasehq/core/query/schema'
import { QueryError } from '../../../core/src/query/errors'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { scopeMiddleware } from '../../../core/src/authorization'
import { capabilities } from '../../../core/src/capabilities'
import { coreConsoleContribution } from '../../../core/src/console-contribution'
import { validateCalendarViews } from '../../../core/src/calendar-display'
import { validateFormDisplay } from '../../../core/src/form-display'
import { validateDetailDisplay } from '../../../core/src/detail-display'
import { ApiError } from '../../../core/src/errors'
import { executeWidgets, validateWidgets, visibleWidgets } from './widgets'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { Scope } from '../../../core/src/types'
import type { ConsoleContribution, ConsoleRegistry, ConsoleNavigation, ConsoleGrant } from './contract'
export type * from './contract'

const contributions = (config: InstanceConfig): ConsoleContribution[] => {
  const plugins = (config.plugins ?? []).flatMap(plugin => plugin.contributes?.console ? [plugin.contributes.console] : [])
  const home = plugins.flatMap(part => part.pages ?? []).find(page => page.path === '/')
  const core = home ? { ...coreConsoleContribution,
    pages: coreConsoleContribution.pages?.filter(page => page.path !== '/'),
    navigation: coreConsoleContribution.navigation?.map(item => item.page === 'core.overview' ? { ...item, page: home.id } : item),
  } : coreConsoleContribution
  return [core, ...plugins]
}
const ordered = (a: { order?: number }, b: { order?: number }) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)

/** Reject collisions and bad destinations before mounting any HTTP surface. */
export function validateConsole(config: InstanceConfig) {
  const parts = contributions(config)
  const pages = parts.flatMap(part => part.pages ?? [])
  const unique = (values: string[], kind: string) => { const seen = new Set<string>(); for (const id of values) { if (seen.has(id)) throw new Error(`Duplicate console ${kind}: ${id}`); seen.add(id) } }
  unique(pages.map(page => page.id), 'page')
  unique(pages.map(page => page.path), 'path')
  const navigation = parts.flatMap(part => part.navigation ?? [])
  unique(navigation.map(item => item.id), 'navigation')
  for (const page of pages) {
    if (!(page.path === '/' || /^\/(?:[a-zA-Z0-9_-]+\/?)+$/.test(page.path)) || (!!page.renderer === !!page.widgets)) throw new Error(`Invalid console page: ${page.id}`)
    validateWidgets(config, page)
  }
  for (const item of navigation) {
    if (!!item.page === !!item.entity || item.page && !pages.some(page => page.id === item.page) || item.entity && !config.entities[item.entity]) throw new Error(`Invalid console destination: ${item.id}`)
  }
  const entities = new Set<string>()
  for (const part of parts) for (const entity of Object.keys(part.entities ?? {})) {
    if (!config.entities[entity]) throw new Error(`Unknown console entity: ${entity}`)
    if (entities.has(entity)) throw new Error(`Duplicate console entity: ${entity}`)
    entities.add(entity)
    validateCalendarViews(config, entity, part.entities![entity].views)
    validateFormDisplay(entity, config.entities[entity], part.entities![entity])
    const detail = part.entities![entity].detail
    if (detail !== undefined) validateDetailDisplay(config, entity, detail)
  }
}

/** Fresh organization/actor projection. No shared cache and no authorization granted by UI. */
export function consoleRegistry(config: InstanceConfig, scope: Scope): ConsoleRegistry {
  const caps = capabilities(kernelFor(config), scope)
  const permits = (grant?: ConsoleGrant) => !grant || (typeof grant === 'string' ? caps.resources[grant as keyof typeof caps.resources] === true : caps.entities[grant.entity]?.operations.includes(grant.operation ?? 'read'))
  const parts = contributions(config)
  const pages = parts.flatMap(part => part.pages ?? []).filter(page => permits(page.grant)).map(page => {
    if (!page.widgets) return page
    const widgets = visibleWidgets(kernelFor(config), scope, page.widgets)
    const ids = new Set(widgets.map(widget => widget.id))
    return { ...page, widgets, sections: page.sections?.map(section => ({ row: section.row.filter(id => ids.has(id)) })).filter(section => section.row.length) }
  })
  const navigation: ConsoleNavigation[] = parts.flatMap(part => part.navigation ?? []).filter(item => (scope.role !== 'member' || item.placement === 'sidebar' && !!item.entity) && permits(item.grant) && (!item.roles || item.roles.includes(scope.role)) && (!item.page || pages.some(page => page.id === item.page)) && (!item.entity || caps.entities[item.entity]?.operations.includes('read')))
  const hints = config.ui?.navigation
  const configured = new Set(hints?.items.map(item => item.entity))
  const entityItems: NonNullable<NonNullable<InstanceConfig['ui']>['navigation']>['items'] = [...(hints?.items ?? []), ...Object.keys(config.entities).filter(entity => !configured.has(entity)).map(entity => ({ id: entity, entity }))]
  for (const item of entityItems) {
    if (item.hidden || !caps.entities[item.entity]?.operations.includes('read') || !caps.entities[item.entity].readable.includes('id') || item.roles && !item.roles.includes(scope.role)) continue
    if (item.view) {
      const view = config.ui?.entities?.[item.entity]?.list?.views?.find(view => view.id === item.view)
      if (!view) continue
      try { validateQuery(kernelFor(config), scope, { entity: item.entity, select: ['id'], limit: 1, where: view.where }) }
      catch (error) { if (error instanceof QueryError) continue; throw error }
    }
    navigation.push({ id: `entity.${item.id}`, placement: 'sidebar', label: item.label || `entity_${item.entity}`, entity: item.entity,
      ...('icon' in item && item.icon ? { icon: item.icon } : {}), ...('view' in item && item.view ? { view: item.view } : {}),
      ...('order' in item ? { order: item.order } : {}), ...('group' in item && item.group ? { group: hints!.groups.find(group => group.id === item.group)! } : {}),
    })
  }
  const entities: ConsoleRegistry['entities'] = Object.fromEntries(Object.entries(config.entities).map(([name, entity]) => [name, {
    ...config.ui?.entities?.[name], fields: Object.fromEntries(Object.entries(entity.fields).flatMap(([field, definition]) => definition.ui ? [[field, definition.ui]] : [])),
  }]))
  for (const part of parts) for (const [entity, display] of Object.entries(part.entities ?? {})) entities[entity] = { ...entities[entity], ...display }
  return { navigation: navigation.sort(ordered), pages, entities, modelUi: config.ui }
}

/** Console metadata and widget execution share the live scoped kernel. */
export function consoleUI(options: { history?: readonly ConfigVersion[] } = {}): WorkbasePlugin {
  return builtinPlugin({
    name: 'console', version: '0.1.0', provides: { console: '1.x' }, validateConsole, consoleRegistry,
    contributes: { console: {
      pages: [{ id: 'console.changes', path: '/settings/changes', label: 'configChanges', renderer: 'console.changes', grant: 'organizations.update' }, { id: 'console.versions', path: '/settings/versions', label: 'configVersions', renderer: 'console.versions', grant: 'organizations.update' }],
      navigation: [{ id: 'console.changes', placement: 'settings', page: 'console.changes', label: 'configChanges', icon: 'Workflow', order: 65,
        group: { id: 'operations', label: 'settingsOperations', order: 100 }, grant: 'organizations.update' }, { id: 'console.versions', placement: 'settings', page: 'console.versions', label: 'configVersions', icon: 'History', order: 70,
        group: { id: 'operations', label: 'settingsOperations', order: 100 }, grant: 'organizations.update' }],
    } },
    routes(app, config, env) {
      const editorEnabled = env.STAGE === 'local' && !!env.CONFIG_EDITOR_TOKEN && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(env.CONFIG_EDITOR_URL ?? '')
      const editor = async (action: string, data: Record<string, unknown> = {}) => {
        if (!editorEnabled) throw new ApiError(503, 'config_editor_disabled')
        const response = await fetch(env.CONFIG_EDITOR_URL!, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CONFIG_EDITOR_TOKEN}` },
          body: JSON.stringify({ ...data, action, instance: config.id }), signal: AbortSignal.timeout(40_000) })
        return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization, X-Organization-Id' } })
      }
      for (const action of ['propose', 'apply'] as const) app.post(`/o/:org/config-changes/${action}`, scopeMiddleware(env, config, kernelFor(config)), async c => {
        if (!consoleRegistry(config, c.get('scope')).pages.some(page => page.id === 'console.changes')) throw new ApiError(403, 'forbidden')
        const body = await c.req.json().catch(() => null)
        const key = action === 'propose' ? 'prompt' : 'proposalId'
        if (!body || typeof body[key] !== 'string' || Object.keys(body).some(field => field !== key) || body[key].length > 2000) throw new ApiError(400, 'invalid_input')
        return editor(action, { [key]: body[key] })
      })
      app.get('/o/:org/config-versions', scopeMiddleware(env, config, kernelFor(config)), async c => {
        if (!consoleRegistry(config, c.get('scope')).pages.some(page => page.id === 'console.versions')) throw new ApiError(403, 'forbidden')
        if (editorEnabled) return editor('history')
        return c.json(versionHistory(config, options.history ?? []), 200, {
          'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization, X-Organization-Id',
        })
      })
      app.get('/o/:org/console-pages/:page', scopeMiddleware(env, config, kernelFor(config)), async c => {
        const scope = c.get('scope')
        const page = consoleRegistry(config, scope).pages.find(page => page.id === c.req.param('page'))
        if (!page?.widgets) throw new ApiError(404, 'console_page_not_found')
        return c.json(await executeWidgets(kernelFor(config), scope, env.DB, page), 200, {
          'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization, X-Organization-Id',
        })
      })
      app.get('/o/:org/console-registry', scopeMiddleware(env, config, kernelFor(config)), c => c.json(consoleRegistry(config, c.get('scope')), 200, {
        'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization, X-Organization-Id',
      }))
    },
  })
}
