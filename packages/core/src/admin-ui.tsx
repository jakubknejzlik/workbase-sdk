/** @jsxImportSource hono/jsx */
import { Q } from '@jakub.knejzlik/ts-query'
import { renderStatement } from './query/compiler'
import { kernelFor } from './kernel/registry'
import type { Child } from 'hono/jsx'
import { getCookie } from 'hono/cookie'
import { ZodError } from 'zod'
import { SESSION_COOKIE } from './session-contract'
import { requireScope } from './authorization'
import { type InstanceConfig, type OrganizationAction } from './config'
import type { App, AppContext, RuntimeEnv, Scope } from './types'
import type { CommandRegistry, CommandDefinition } from './commands'
import { ApiError } from './errors'
import { assertIdentityTransport } from './identity-settings'
import { adminForm, browserRequest, csrfToken, isLoopbackDev, submissionKey, verifySubmissionKey } from './admin-security'
import { CommandInput, FieldInput, Form, Hidden, commandBody, commandFields, entityBody } from './admin-forms'
import { organizationPermission } from './execution/permissions'
import { permission } from './crud'
import { createLogger } from './logging'
import { securityLog } from './events'
import { workflowReader } from './workflow-routes'
import type { WorkflowRegistry } from './workflow-runtime'

const workflowStatuses = ['needs_attention', 'pending', 'running', 'waiting_external', 'completed', 'failed', 'compensating', 'compensated', 'cancelled']
const workflowTime = (value: number | null) => value ? new Date(value).toISOString() : '—'

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
const css = `:root{font:16px system-ui,sans-serif;color:#172b3a;background:#f4f6f8}body{max-width:1100px;margin:auto;padding:1.5rem}a{color:#075a97}header,nav{display:flex;gap:1rem;flex-wrap:wrap;align-items:center}header{justify-content:space-between;border-bottom:1px solid #ccd4dc;padding-bottom:1rem}main{background:white;padding:1.5rem;margin-top:1rem;border:1px solid #d8dfe5;border-radius:.5rem}nav{margin-top:1rem}form{margin:1rem 0;padding:1rem;border:1px solid #d8dfe5;border-radius:.3rem}label{display:block;margin:.7rem 0}input,select,textarea,button{font:inherit;max-width:100%;box-sizing:border-box}input:not([type=hidden]),select,textarea{display:block;padding:.4rem;width:32rem}input[type=checkbox]{width:auto;display:inline}button{padding:.4rem .8rem;cursor:pointer}table{border-collapse:collapse;width:100%;display:block;overflow:auto}td,th{text-align:left;border-bottom:1px solid #d8dfe5;padding:.6rem;vertical-align:top}td form{margin:.2rem;padding:.4rem}td input,td select{width:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}code{overflow-wrap:anywhere}.error{color:#9b1c1c}small{color:#526272}`
const enc = encodeURIComponent
const roles = ['owner', 'dispatcher', 'viewer']
const roleInput = (current = 'viewer', ceiling = 'owner') => <label>Role<select name="role">{roles.filter(role => roles.indexOf(role) >= roles.indexOf(ceiling)).map(role => <option value={role} selected={role === current}>{role}</option>)}</select></label>
const human: Record<string, string> = {
  csrf_failed: 'This form could not be verified. Reload the page and try again.',
  permission_denied: 'Your role does not allow this action.', organization_forbidden: 'You do not have access to this organization.',
  last_owner: 'An organization must keep at least one owner.', version_conflict: 'This record changed. Reload it before saving again.',
  validation_error: 'Check the required fields and their formats.', internal_error: 'The request could not be completed.',
  workflow_not_paused: 'Only a workflow run that needs attention can be resumed.', workflow_terminal: 'This workflow run has already finished.',
  'workflow.definition_mismatch': 'The saved workflow definition differs from this instance. Restore compatible code before continuing.',
  owner_required: 'Only an organization owner can use this page.', commands_only: 'Use a command to change this entity.',
}
function errorInfo(error: unknown) {
  if (error instanceof ApiError) return error
  const message = error instanceof Error ? error.message : ''
  const constraint = /SQLITE_CONSTRAINT|constraint failed/i.test(message)
  return new ApiError(error instanceof ZodError || error instanceof SyntaxError || error instanceof URIError ? 400 : constraint ? 409 : 500,
    error instanceof ZodError || error instanceof SyntaxError || error instanceof URIError ? 'validation_error' : constraint ? 'constraint_conflict' : 'internal_error')
}
function errorMessage(error: ApiError) {
  return <p class="error" role="alert">{human[error.code] ?? `${error.code.replaceAll('_', ' ')}.`} <code>{error.code}</code></p>
}
function canOrganization(config: InstanceConfig, scope: Scope, action: OrganizationAction) {
  try { kernelFor(config).resourcePermission(scope, action); organizationPermission(config, scope, action); return true } catch (error) { if (error instanceof ApiError) return false; throw error }
}
function canCommand(config: InstanceConfig, scope: Scope, command: CommandDefinition) {
  if ('system' in command.permission) return false
  return [command.permission, ...(command.additionalPermissions ?? [])].every(grant => kernelFor(config).can(scope, grant.entity, grant.operation))
}
// The legacy admin is English-only and has no translation catalog for labelKey.
function adminCommandLabel(name: string, command?: CommandDefinition) {
  const label = command?.ui?.label
  if (label) return typeof label === 'string' ? label : label.en
  const words = name.split('/').at(-1)!.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Browser adapter only. Richer presentation can replace these views while retaining the JSON/public execution interfaces. */
export function adminRoutes(app: App, config: InstanceConfig, env: RuntimeEnv, commands: CommandRegistry = new Map(), workflows: WorkflowRegistry = new Map()) {
  const secret = env.IDENTITY?.secret ?? ''
  function page(c: AppContext, title: string, children: Child, csrf = '', scope?: Scope, status = 200) {
    const root = scope ? `/admin/o/${enc(scope.organizationId)}` : ''
    const html = <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>{title} · Workbase</title><style>{css}</style></head>
      <body><header><a href="/admin">Workbase · {config.id}</a>{csrf && getCookie(c, SESSION_COOKIE) ? <Form action="/auth/logout" csrf={csrf} label="Log out" /> : null}</header>
        {scope ? <nav aria-label="Organization"><a href={root}>Overview</a>
          {canOrganization(config, scope, 'members.read') ? <a href={`${root}/members`}>Members</a> : null}
          {canOrganization(config, scope, 'invitations.read') ? <a href={`${root}/invitations`}>Invitations</a> : null}
          {canOrganization(config, scope, 'tokens.read') ? <a href={`${root}/tokens`}>Agent tokens</a> : null}
          {Object.keys(config.entities).filter(name => kernelFor(config).can(scope, name, 'read')).map(name => <a href={`${root}/entities/${name}`}>{name}</a>)}
          <a href={`${root}/commands`}>Commands</a><a href={`${root}/workflows`}>Workflows</a>{kernelFor(config).audit && scope.role === 'owner' ? <a href={`${root}/audit`}>Audit</a> : null}
        </nav> : null}<main><h1>{title}</h1>{children}</main></body></html>
    return c.html(`<!doctype html>${html.toString()}`, status as any)
  }
  async function api(c: AppContext, path: string, org?: string, method = 'GET', body?: unknown, validatedAuthForm = false) {
    const headers = new Headers({ Accept: 'application/json', 'X-Correlation-Id': c.get('correlationId') })
    for (const name of ['Cookie', 'Origin', 'Sec-Fetch-Site', 'CF-Connecting-IP']) {
      const value = c.req.header(name); if (value) headers.set(name, value)
    }
    // Only auth adapters set this flag, after adminForm validates provenance and CSRF.
    if (validatedAuthForm) headers.set('Origin', new URL(c.req.url).origin)
    if (org) headers.set('X-Organization-Id', org)
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    // Local Hono dispatch, never fetch(): no network, duplicate writes or alternate authorization implementation.
    const response = await app.fetch(new Request(new URL(path, c.req.url), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    for (const cookie of response.headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true })
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as any
      throw new ApiError(response.status, typeof result.error === 'string' ? result.error : 'request_failed', typeof result.hint === 'string' ? result.hint : undefined)
    }
    return response.status === 204 ? {} : await response.json() as any
  }
  async function wrapped(c: AppContext, run: (onError: (renderer: (error: ApiError) => Promise<Response>) => void) => Promise<Response>, route: string) {
    c.header('Content-Security-Policy', CSP)
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Content-Type-Options', 'nosniff')
    let response: Response
    let errorRenderer: ((error: ApiError) => Promise<Response>) | undefined
    try { response = await run(renderer => { errorRenderer = renderer }) } catch (cause) {
      const error = errorInfo(cause)
      if ([403, 409].includes(error.status)) await securityLog(env.DB, { ...c.get('scope'), correlationId: c.get('correlationId') }, `${c.req.method} ${route}`, error.status)
      const reload = c.req.path.replace(/\/(members|invitations|tokens)\/[^/]+\/(role|remove|revoke)$/, '/$1')
      response = errorRenderer && [400, 409, 422].includes(error.status) ? await errorRenderer(error) : page(c, 'Request failed', <><p class="error" role="alert">{human[error.code] ?? `${error.code.replaceAll('_', ' ')}.`} <code>{error.code}</code></p><p><a href={reload.startsWith('/admin/') ? reload : '/admin'}>Reload page</a> · <a href="/admin">Organizations</a></p></>, '', undefined, error.status)
    }
    createLogger({ stage: env.STAGE ?? 'local', correlationId: c.get('correlationId'), route })('info', 'admin.page', { status: response.status })
    return response
  }
  async function login(c: AppContext, email = '', error?: ApiError) {
    assertIdentityTransport(c.req.raw, 403)
    return page(c, 'Sign in', <><p>Enter your email address to receive a sign-in link.</p>{error ? errorMessage(error) : null}
      <Form action="/auth/sign-in/magic-link" csrf={await csrfToken(c, secret)} label="Send magic link"><Hidden name="callbackURL" value="/admin" /><label>Email<input type="email" name="email" required autocomplete="email" value={email} /></label></Form></>, '', undefined, error?.status)
  }
  // These two form adapters are installed before authRoutes; JSON REST clients keep their existing behavior.
  for (const path of ['/auth/sign-in/magic-link', '/auth/logout']) app.use(path, async (c, next) => {
    if (c.req.method !== 'POST' || !/^(?:application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)(?:;|$)/i.test(c.req.header('Content-Type') ?? '')) return next()
    return wrapped(c, async onError => {
      const form = await adminForm(c, secret)
      if (path === '/auth/sign-in/magic-link') {
        onError(error => login(c, form.get('email') ?? '', error))
        await api(c, path, undefined, 'POST', { email: form.get('email'), callbackURL: '/admin' }, true)
        return page(c, 'Check your mailbox', <p>Check your mailbox for a sign-in link.</p>)
      }
      if (!getCookie(c, SESSION_COOKIE)) throw new ApiError(401, 'unauthenticated')
      await kernelFor(config).requireActor(browserRequest(c), env)
      await api(c, path, undefined, 'POST', {}, true)
      return c.redirect('/admin/login', 303)
    }, path)
  })
  const handle = (c: AppContext) => wrapped(c, async onError => {
    if (c.req.path === '/admin/login' && c.req.method === 'GET') return login(c)
    // Validate POST provenance even when the session has expired. All admin mutations use POST.
    const form = c.req.method === 'POST' ? await adminForm(c, secret) : undefined
    if (!['GET', 'POST'].includes(c.req.method)) throw new ApiError(405, 'method_not_allowed')
    assertIdentityTransport(c.req.raw, 403)
    if (!getCookie(c, SESSION_COOKIE)) return c.redirect('/admin/login', 302)
    let actor
    try { actor = await kernelFor(config).requireActor(browserRequest(c), env) } catch (error) {
      if (error instanceof ApiError && error.status === 401) return c.redirect('/admin/login', 302)
      throw error
    }
    if (!actor.user) throw new ApiError(403, 'user_required')
    const csrf = await csrfToken(c, secret)
    if (c.req.path === '/admin' || c.req.path === '/admin/') {
      const organizationsForm = async (error?: ApiError) => page(c, 'Organizations', <><ul>{actor.organizations.map(org => <li><a href={`/admin/o/${enc(org.id)}`}>{org.name}</a> ({org.role})</li>)}</ul>
        <h2>Create organization</h2>{error ? errorMessage(error) : null}<Form action="/admin" csrf={csrf} label="Create organization"><label>Name<input name="name" required maxlength={200} value={form?.get('name') ?? ''} /></label></Form></>, csrf, undefined, error?.status)
      onError(organizationsForm)
      if (form) {
        const org = await api(c, '/orgs', undefined, 'POST', { name: form.get('name') })
        return c.redirect(`/admin/o/${enc(org.id)}`, 303)
      }
      return organizationsForm()
    }
    const match = /^\/admin\/o\/([^/]+)(?:\/(.*))?$/.exec(c.req.path)
    if (!match) throw new ApiError(404, 'not_found')
    const org = decodeURIComponent(match[1]); const tail = match[2] ?? ''
    const organization = await env.DB.prepare('SELECT id,name FROM organizations WHERE id=?').bind(org).first<{ id: string; name: string }>()
    if (!organization) throw new ApiError(404, 'organization_not_found')
    const scope = await requireScope(actor, org, config, c.get('correlationId'))
    c.set('scope', scope)
    const root = `/admin/o/${enc(org)}`
    const workflowRead = workflowReader(config, env, workflows, actor, org, c.get('correlationId'))
    const orgApi = `/orgs/${enc(org)}`
    const render = (title: string, body: Child, status = 200) => page(c, title, body, csrf, scope, status)
    if (!tail) {
      if (form) throw new ApiError(405, 'method_not_allowed')
      const counts = []
      for (const name of Object.keys(config.entities)) {
        if (!kernelFor(config).can(scope, name, 'read')) continue
        permission(config, scope, name, 'read')
        const filter = renderStatement(kernelFor(config), scope, Q.select().from(name, 'count_row').field(Q.raw('COUNT(*)'), 'n'))
        const n = await env.DB.prepare(filter.sql).bind(...filter.bindings).first<number>('n')
        counts.push(<li><a href={`${root}/entities/${name}`}>{name}</a>: {n}</li>)
      }
      const workflowCounts = await workflowRead.counts()
      return render(organization.name, <><p>Role: {scope.role}</p><ul>{counts}</ul><h2>Workflow runs</h2><ul>{workflowStatuses.map(status => <li><a href={`${root}/workflows?status=${status}`}>{status === 'needs_attention' ? <strong>{status}: {workflowCounts[status] ?? 0}</strong> : `${status}: ${workflowCounts[status] ?? 0}`}</a></li>)}</ul></>)
    }
    if (tail === 'workflows' || tail.startsWith('workflows/')) {
      const workflowRoot = `${root}/workflows`
      if (tail === 'workflows') {
        if (form) throw new ApiError(405, 'method_not_allowed')
        const status = c.req.query('status') ?? 'needs_attention'
        if (status !== 'all' && !workflowStatuses.includes(status)) throw new ApiError(400, 'invalid_status')
        const runs = await workflowRead.list(status === 'all' ? undefined : status, true)
        const catalog = await workflowRead.catalog()
        return render('Workflows', <><nav aria-label="Workflow status">{['needs_attention', 'all', ...workflowStatuses.slice(1)].map(value => <a href={`${workflowRoot}?status=${value}`} aria-current={value === status ? 'page' : undefined}>{value === 'all' ? 'All' : value}</a>)}</nav>
          {catalog.length ? <p><a href={`${workflowRoot}/new`}>Start workflow</a></p> : null}<p>Newest 100 runs for this filter.</p>
          {!runs.length ? <p>{status === 'needs_attention' ? 'No workflow runs need attention.' : 'No workflow runs match this filter.'}</p> : <table><thead><tr><th>Run</th><th>Definition / version</th><th>Status</th><th>Last error code</th><th>Started / updated</th><th>Initiating actor type</th></tr></thead><tbody>{runs.map(run => <tr><td><a href={`${workflowRoot}/${enc(run.id)}`}>{run.id.slice(0, 6)}…{run.id.slice(-6)}</a></td><td>{run.definition_name} / {run.definition_version}</td><td>{run.status}</td><td>{run.last_error_code ?? '—'}</td><td>{run.created_at}<br />{run.updated_at}</td><td>{run.actor_type}</td></tr>)}</tbody></table>}</>)
      }
      if (tail === 'workflows/new') {
        const catalog = await workflowRead.catalog()
        const selected = form?.get('definition') ?? c.req.query('definition') ?? catalog[0]?.name
        const definition = workflows.get(selected ?? '')
        if (definition) await workflowRead.startScope(definition)
        else if (selected) throw new ApiError(404, 'workflow_not_found')
        const startForm = async (error?: ApiError) => {
          const fields = []
          for (const field of definition ? commandFields(definition.input) : []) {
            const reference = field.definition.referenceEntity
            const entity = typeof reference === 'string' && Object.hasOwn(config.entities, reference) ? reference : undefined
            fields.push(entity ? <FieldInput name={field.name} field={{ type: 'ref', entity, required: field.required }} value={form?.get(field.name) ?? undefined} choices={(await api(c, `/api/${enc(entity)}?limit=90`, org)).data} />
              : <CommandInput {...field} value={form?.get(field.name) ?? undefined} />)
          }
          return render('Start workflow', <>{error ? errorMessage(error) : null}{catalog.length ? <><form method="get" action={`${workflowRoot}/new`}><label>Definition<select name="definition">{catalog.map(item => <option value={item.name} selected={item.name === selected}>{item.name} / {item.version}</option>)}</select></label><button type="submit">Choose definition</button></form>
            <h2>{definition?.name} / {definition?.version}</h2><Form action={`${workflowRoot}/new`} csrf={csrf} label="Start workflow"><Hidden name="definition" value={selected} /><Hidden name="idempotencyKey" value={form?.get('idempotencyKey') ?? await submissionKey(csrf)} />{fields}</Form></> : <p>No workflow definitions are available for your role on this instance.</p>}</>, error?.status)
        }
        if (form) {
          if (!definition) throw new ApiError(403, 'workflow_forbidden')
          await verifySubmissionKey(csrf, form.get('idempotencyKey') ?? '')
          onError(startForm)
          const result = await api(c, `/workflows/${definition.name}`, org, 'POST', commandBody(form, definition.input))
          return c.redirect(`${workflowRoot}/${enc(result.id)}`, 303)
        }
        return startForm()
      }
      const runMatch = /^workflows\/([^/]+)(?:\/(resume|cancel))?$/.exec(tail)
      if (!runMatch) throw new ApiError(404, 'not_found')
      const id = decodeURIComponent(runMatch[1]); const action = runMatch[2]
      const detailPath = `${workflowRoot}/${enc(id)}`
      const detail = async (error?: ApiError) => {
        const run = await workflowRead.detail(id, true)
        // Audit has its own owner-only read authority; do not bypass it for run readers.
        const query = new URLSearchParams({ entity: 'workflows', entity_id: id, limit: '25' })
        if (c.req.query('audit_cursor')) query.set('cursor', c.req.query('audit_cursor')!)
        const events = kernelFor(config).audit && scope.role === 'owner' ? await api(c, `/audit/events?${query}`, org) : undefined
        return render('Workflow run', <>{error ? errorMessage(error) : null}<p><code>{id}</code></p><p>{run.definition_name} / {run.definition_version}</p><p>Status: <strong>{run.status}</strong></p><p>Last error code: <code>{run.last_error_code ?? '—'}</code></p><p>Started: {run.created_at} · Updated: {run.updated_at}</p>
          <h2>Steps</h2><table><thead><tr><th>Step</th><th>Disposition</th><th>Attempts / undo attempts</th><th>Deadline / undo deadline (UTC)</th><th>Next attempt (UTC)</th><th>Error code</th></tr></thead><tbody>{run.steps.map((step: any) => <tr><td>{step.step_id}</td><td>{step.status}</td><td>{step.attempts} / {step.compensation_attempts}</td><td>{workflowTime(step.deadline_at)}<br />{workflowTime(step.compensation_deadline_at)}</td><td>{workflowTime(step.next_attempt_at)}</td><td>{step.last_error_code ?? '—'}</td></tr>)}</tbody></table>
          <h2>Result</h2><pre>{JSON.stringify(run.result, null, 2)}</pre>
          {scope.role === 'owner' ? <>{run.status === 'needs_attention' ? <Form action={`${detailPath}/resume`} csrf={csrf} label="Resume"><Hidden name="idempotencyKey" value={await submissionKey(csrf)} /></Form> : null}
            {!['completed', 'compensated', 'cancelled'].includes(run.status) ? <Form action={`${detailPath}/cancel`} csrf={csrf} label="Cancel"><Hidden name="idempotencyKey" value={await submissionKey(csrf)} /></Form> : null}</> : null}
          {kernelFor(config).audit ? <><h2>Audit events</h2>{events ? <><p>Delivered events only, 25 per page. Delivery may be delayed.</p>{events.data.length ? events.data.map((event: any) => <article><h3>{event.operation}</h3><p>{event.occurred_at} · {event.actor.type}</p>{event.details?.step_id ? <p>Step: {event.details.step_id}</p> : null}{event.details?.code ? <p>Error code: <code>{event.details.code}</code></p> : null}</article>) : <p>No delivered audit events for this run.</p>}{events.next_cursor ? <a rel="next" href={`${detailPath}?audit_cursor=${enc(events.next_cursor)}`}>Next audit page</a> : null}</> : <p>Audit events are available to organization owners.</p>}</> : null}
        </>, error?.status)
      }
      if (form) {
        if (!action) throw new ApiError(405, 'method_not_allowed')
        if (scope.role !== 'owner') throw new ApiError(403, 'owner_required')
        await verifySubmissionKey(csrf, form.get('idempotencyKey') ?? '')
        onError(detail)
        await api(c, `/workflows/${enc(id)}/${action}`, org, 'POST', {})
        return c.redirect(detailPath, 303)
      }
      if (action) throw new ApiError(404, 'not_found')
      return detail()
    }
    if (tail === 'members' || tail.startsWith('members/')) {
      if (form) {
        const member = /^members\/([^/]+)\/(role|remove)$/.exec(tail)
        if (!member) throw new ApiError(404, 'not_found')
        if (member[2] === 'role') {
          organizationPermission(config, scope, 'members.update')
          onError(async error => render('Members', <>{errorMessage(error)}<Form action={`${root}/${tail}`} csrf={csrf} label="Change role">{roleInput(form.get('role') ?? 'viewer')}</Form></>, error.status))
        }
        await api(c, `${orgApi}/members/${member[1]}`, org, member[2] === 'remove' ? 'DELETE' : 'PATCH', member[2] === 'role' ? { role: form.get('role') } : undefined)
        return c.redirect(`${root}/members`, 303)
      }
      if (tail !== 'members') throw new ApiError(404, 'not_found')
      const result = await api(c, `${orgApi}/members`, org)
      return render('Members', <table><thead><tr><th>Email</th><th>Role</th><th>Actions</th></tr></thead><tbody>{result.data.map((member: any) => <tr><td>{member.email}</td><td>{member.role}</td><td>
        {canOrganization(config, scope, 'members.update') ? <Form action={`${root}/members/${enc(member.user_id)}/role`} csrf={csrf} label="Change role">{roleInput(member.role)}</Form> : null}
        {canOrganization(config, scope, 'members.remove') ? <Form action={`${root}/members/${enc(member.user_id)}/remove`} csrf={csrf} label="Remove member" /> : null}
      </td></tr>)}</tbody></table>)
    }
    if (tail === 'invitations' || tail.startsWith('invitations/')) {
      if (form) {
        if (tail === 'invitations') {
          organizationPermission(config, scope, 'invitations.create')
          onError(async error => render('Invitations', <>{errorMessage(error)}<Form action={`${root}/invitations`} csrf={csrf} label="Send invitation"><label>Email<input type="email" name="email" required value={form.get('email') ?? ''} /></label>{roleInput(form.get('role') ?? 'viewer', scope.role)}</Form></>, error.status))
          const created = await api(c, `${orgApi}/invitations`, org, 'POST', { email: form.get('email'), role: form.get('role') })
          let link: string | null = null
          if (isLoopbackDev(c.req.raw, env.STAGE)) {
            // Only the authorized create result may supply this local development link.
            organizationPermission(config, scope, 'invitations.create')
            link = created.accept_url ?? null
          }
          return render('Invitation created', <><p>Sent to {created.email}.</p>{link ? <p>Local development invitation: <a href={link}>{link}</a></p> : null}<a href={`${root}/invitations`}>Invitations</a></>, 201)
        }
        const revoke = /^invitations\/([^/]+)\/revoke$/.exec(tail)
        if (!revoke) throw new ApiError(404, 'not_found')
        await api(c, `${orgApi}/invitations/${revoke[1]}`, org, 'DELETE')
        return c.redirect(`${root}/invitations`, 303)
      }
      if (tail !== 'invitations') throw new ApiError(404, 'not_found')
      const result = await api(c, `${orgApi}/invitations`, org)
      return render('Invitations', <><table><thead><tr><th>Email</th><th>Role</th><th>Status / expiry</th><th>Actions</th></tr></thead><tbody>{result.data.map((invitation: any) => <tr><td>{invitation.email}</td><td>{invitation.role}</td><td>{invitation.revoked_at ? 'Revoked' : invitation.accepted_at ? 'Accepted' : invitation.expires_at}</td><td>
        {!invitation.revoked_at && !invitation.accepted_at && canOrganization(config, scope, 'invitations.revoke') ? <Form action={`${root}/invitations/${enc(invitation.id)}/revoke`} csrf={csrf} label="Revoke invitation" /> : null}
      </td></tr>)}</tbody></table>{canOrganization(config, scope, 'invitations.create') ? <><h2>Invite a member</h2><Form action={`${root}/invitations`} csrf={csrf} label="Send invitation"><label>Email<input type="email" name="email" required /></label>{roleInput('viewer', scope.role)}</Form></> : null}</>)
    }
    if (tail === 'tokens' || tail.startsWith('tokens/')) {
      if (form) {
        if (tail === 'tokens') {
          organizationPermission(config, scope, 'tokens.create')
          onError(async error => render('Agent tokens', <>{errorMessage(error)}<Form action={`${root}/tokens`} csrf={csrf} label="Create token"><label>Name<input name="name" required maxlength={200} value={form.get('name') ?? ''} /></label>{roleInput(form.get('role') ?? 'viewer')}<label>Allowed operations (comma-separated; blank = role permissions)<input name="operations" value={form.get('operations') ?? ''} /></label></Form></>, error.status))
          const result = await api(c, `${orgApi}/tokens`, org, 'POST', { name: form.get('name'), role: form.get('role'), ...(form.get('operations') ? { operations: form.get('operations')!.split(',').map(op => op.trim()).filter(Boolean) } : {}) })
          return render('Agent token created', <><p>Copy this token now. It is shown only once.</p><pre>{result.token}</pre><a href={`${root}/tokens`}>Agent tokens</a></>, 201)
        }
        const revoke = /^tokens\/([^/]+)\/revoke$/.exec(tail)
        if (!revoke) throw new ApiError(404, 'not_found')
        await api(c, `${orgApi}/tokens/${revoke[1]}`, org, 'DELETE')
        return c.redirect(`${root}/tokens`, 303)
      }
      if (tail !== 'tokens') throw new ApiError(404, 'not_found')
      const result = await api(c, `${orgApi}/tokens`, org)
      return render('Agent tokens', <><table><thead><tr><th>Name / prefix</th><th>Role / operations</th><th>Expiry</th><th>Actions</th></tr></thead><tbody>{result.data.map((token: any) => <tr><td>{token.name} / {token.prefix}</td><td>{token.role} / {(token.operations ?? ['all permitted operations']).join(', ')}</td><td>{token.expires_at}</td><td>{!token.revoked_at && canOrganization(config, scope, 'tokens.revoke') ? <Form action={`${root}/tokens/${enc(token.id)}/revoke`} csrf={csrf} label="Revoke token" /> : token.revoked_at ? 'Revoked' : null}</td></tr>)}</tbody></table>
        {canOrganization(config, scope, 'tokens.create') ? <><h2>Create agent token</h2><Form action={`${root}/tokens`} csrf={csrf} label="Create token"><label>Name<input name="name" required maxlength={200} /></label>{roleInput()}<label>Allowed operations (comma-separated; blank = role permissions)<input name="operations" /></label></Form></> : null}</>)
    }
    if (tail === 'commands' || tail.startsWith('commands/')) {
      const selected = tail === 'commands' ? undefined : decodeURIComponent(tail.slice('commands/'.length))
      if (selected && !config.commands.includes(selected)) throw new ApiError(404, 'command_not_found')
      const command = selected ? commands.get(selected) : undefined
      const authorizeCommand = () => {
        if (!command) throw new ApiError(405, 'unsupported_command')
        if ('system' in command.permission) throw new ApiError(405, 'unsupported_command')
        for (const grant of [command.permission, ...(command.additionalPermissions ?? [])]) permission(config, scope, grant.entity, grant.operation)
      }
      const forms = async (error?: ApiError) => render('Commands', <>{error && !commandFields(command!.input).some(field => field.name === error.hint) ? errorMessage(error) : null}{await Promise.all(config.commands.filter(name => !selected || name === selected).map(async name => {
        const definition = commands.get(name)
        const label = adminCommandLabel(name, definition)
        return <section><h2>{label}</h2>{definition && canCommand(config, scope, definition) ? <Form action={`${root}/commands/${name}`} csrf={csrf} label={label}>
          <Hidden name="idempotencyKey" value={form?.get('idempotencyKey') ?? await submissionKey(csrf)} />
          {commandFields(definition.input).map(field => <CommandInput {...field} value={form?.get(field.name) ?? undefined} error={error?.hint === field.name ? errorMessage(error) : undefined} />)}
        </Form> : <p>{definition ? 'Your role cannot run this command.' : 'This command is not registered.'}</p>}</section>
      }))}</>, error?.status)
      if (form) {
        authorizeCommand()
        const key = await verifySubmissionKey(csrf, form.get('idempotencyKey') ?? '')
        onError(forms)
        await api(c, `/commands/${selected}`, org, 'POST', commandBody(form, command!.input))
        return c.redirect(`${root}/commands/${selected}?receipt=${enc(key)}`, 303)
      }
      if (c.req.query('receipt') !== undefined) {
        authorizeCommand()
        const key = await verifySubmissionKey(csrf, c.req.query('receipt')!)
        const receipt = await env.DB.prepare('SELECT response_json FROM idempotency_keys WHERE organization_id=? AND key=? AND command=?').bind(org, key, selected).first<string>('response_json')
        if (!receipt) throw new ApiError(404, 'receipt_not_found')
        return render('Command completed', <><pre>{JSON.stringify(JSON.parse(receipt).body, null, 2)}</pre><a href={`${root}/commands`}>Commands</a></>)
      }
      return forms()
    }
    if (tail === 'audit') {
      if (!kernelFor(config).audit) throw new ApiError(404, 'not_found')
      if (form) throw new ApiError(405, 'method_not_allowed')
      const query = new URLSearchParams()
      for (const key of ['entity', 'entity_id', 'from', 'to']) if (c.req.query(key)) query.set(key, c.req.query(key)!)
      query.set('limit', '25')
      if (c.req.query('cursor') !== undefined) query.set('cursor', c.req.query('cursor')!)
      const result = await api(c, `/audit/events?${query}`, org)
      const next = new URLSearchParams(query); if (result.next_cursor) next.set('cursor', result.next_cursor)
      return render('Audit', <><form method="get" action={`${root}/audit`}>{['entity', 'entity_id', 'from', 'to'].map(key => <label>{key}<input name={key} value={query.get(key) ?? ''} /></label>)}<button type="submit">Filter audit</button></form>
        <p>Delivered events only, 25 per page. Delivery may be delayed.</p>
        {result.data.map((event: any) => <article><h2>{event.operation}</h2><pre>{JSON.stringify(event, null, 2)}</pre></article>)}
        {result.next_cursor ? <a rel="next" href={`${root}/audit?${next}`}>Next page</a> : null}</>)
    }
    const entityMatch = /^entities\/([^/]+)(?:\/([^/]+))?(?:\/(edit|delete))?$/.exec(tail)
    if (!entityMatch) throw new ApiError(404, 'not_found')
    const name = decodeURIComponent(entityMatch[1]); const id = entityMatch[2] ? decodeURIComponent(entityMatch[2]) : undefined; const action = entityMatch[3]
    if (!Object.hasOwn(config.entities, name)) throw new ApiError(404, 'entity_not_found')
    const definition = config.entities[name]
    const entityRoot = `${root}/entities/${name}`
    const apiRoot = `/api/${name}`
    if (form) {
      permission(config, scope, name, action === 'delete' ? 'delete' : id ? 'update' : 'create')
      if (definition.commandsOnly) throw new ApiError(405, 'commands_only')
      if (action === 'delete') {
        if (form.get('confirm') !== 'yes') throw new ApiError(400, 'confirmation_required')
        await api(c, `${apiRoot}/${enc(id!)}`, org, 'DELETE')
        return c.redirect(entityRoot, 303)
      }
      if (id && action !== 'edit') throw new ApiError(405, 'method_not_allowed')
      onError(error => entityForm(error))
      const body = entityBody(form, definition.fields)
      if (id) body.version = Number(form.get('version'))
      const result = await api(c, id ? `${apiRoot}/${enc(id)}` : apiRoot, org, id ? 'PATCH' : 'POST', body)
      return c.redirect(`${entityRoot}/${enc(result.id)}`, 303)
    }
    async function fields(row: Record<string, any> = {}, error?: ApiError) {
      const elements = []
      for (const [key, field] of Object.entries(definition.fields)) {
        if (field.readOnly) continue
        let choices: Record<string, any>[] = []
        if (field.type === 'ref' && kernelFor(config).can(scope, field.entity!, 'read')) choices = (await api(c, `/api/${field.entity}?limit=90`, org)).data
        elements.push(<FieldInput name={key} field={field} value={row[key]} choices={choices} error={error?.hint === key ? errorMessage(error) : undefined} />)
      }
      return elements
    }
    async function entityForm(error: ApiError) {
      const row = Object.fromEntries(form!)
      return render(`${id ? 'Edit' : 'Create'} ${name}`, <>
        {error.hint && Object.hasOwn(definition.fields, error.hint) && !definition.fields[error.hint].readOnly ? null : errorMessage(error)}
        <Form action={id ? `${entityRoot}/${enc(id)}/edit` : entityRoot} csrf={csrf} label={id ? 'Save' : 'Create'}>
          {id ? <Hidden name="version" value={form!.get('version')} /> : null}{await fields(row, error)}
        </Form></>, error.status)
    }
    const commandLinks = <><p>This entity is changed through commands.</p>{config.commands.map(commandName => {
      const command = commands.get(commandName)
      return command && 'entity' in command.permission && command.permission.entity === name && canCommand(config, scope, command)
        ? <form method="get" action={`${root}/commands/${commandName}`}><button type="submit">{adminCommandLabel(commandName, command)}</button></form> : null
    })}<a href={`${root}/commands`}>Open commands</a></>
    if (id === 'new') {
      if (action) throw new ApiError(404, 'not_found')
      permission(config, scope, name, 'create')
      return render(`Create ${name}`, definition.commandsOnly ? commandLinks : <><p>Dates and times use UTC. Relation choices show at most 90 rows.</p><Form action={entityRoot} csrf={csrf} label="Create">{await fields()}</Form></>)
    }
    if (id) {
      const row = await api(c, `${apiRoot}/${enc(id)}`, org)
      if (action === 'edit') {
        permission(config, scope, name, 'update')
        return render(`Edit ${name}`, definition.commandsOnly ? commandLinks : <><p>Dates and times use UTC. Relation choices show at most 90 rows.</p><Form action={`${entityRoot}/${enc(id)}/edit`} csrf={csrf}><Hidden name="version" value={row.version} />{await fields(row)}</Form></>)
      }
      if (action === 'delete') {
        permission(config, scope, name, 'delete')
        return render(`Delete ${name}`, definition.commandsOnly ? commandLinks : <><p>Delete this record permanently?</p><pre>{JSON.stringify(row, null, 2)}</pre><Form action={`${entityRoot}/${enc(id)}/delete`} csrf={csrf} label="Confirm delete"><label><input type="checkbox" name="confirm" value="yes" required /> I confirm deletion</label></Form></>)
      }
      return render(`${name} detail`, <><pre>{JSON.stringify(row, null, 2)}</pre>{definition.commandsOnly ? commandLinks : <p>
        {kernelFor(config).can(scope, name, 'update') ? <a href={`${entityRoot}/${enc(id)}/edit`}>Edit</a> : null}{' '}
        {kernelFor(config).can(scope, name, 'delete') ? <a href={`${entityRoot}/${enc(id)}/delete`}>Delete</a> : null}</p>}</>)
    }
    const query = new URLSearchParams()
    for (const key of ['limit', 'cursor']) if (c.req.query(key)) query.set(key, c.req.query(key)!)
    // Reference fields have generated organization-scoped indexes. Avoid arbitrary full-scan filters.
    const filterFields = Object.entries(definition.fields).filter(([, field]) => field.type === 'ref')
    for (const [key] of filterFields) if (c.req.query(key)) query.set(key, c.req.query(key)!)
    const result = await api(c, `${apiRoot}?${query}`, org)
    const next = new URLSearchParams(query); if (result.next_cursor) next.set('cursor', result.next_cursor)
    return render(name, <>{definition.commandsOnly ? commandLinks : kernelFor(config).can(scope, name, 'create') ? <p><a href={`${entityRoot}/new`}>Create {name}</a></p> : null}
      <form method="get" action={entityRoot}><label>Rows per page<input name="limit" type="number" min={1} max={90} value={query.get('limit') ?? '25'} /></label>{filterFields.map(([key]) => <label>{key}<input name={key} value={query.get(key) ?? ''} /></label>)}<button type="submit">Filter</button></form>
      <table><thead><tr><th>Record</th>{Object.keys(definition.fields).map(key => <th>{key}</th>)}</tr></thead><tbody>{result.data.map((row: any) => <tr><td><a href={`${entityRoot}/${enc(row.id)}`}>{row.id}</a></td>{Object.keys(definition.fields).map(key => <td>{String(row[key] ?? '')}</td>)}</tr>)}</tbody></table>
      {result.next_cursor ? <a rel="next" href={`${entityRoot}?${next}`}>Next page</a> : null}</>)
  }, c.req.path === '/admin/login' ? '/admin/login' : c.req.path === '/admin' || c.req.path === '/admin/' ? '/admin' : '/admin/o/:orgId/*')
  app.all('/admin', handle)
  app.all('/admin/*', handle)
}
