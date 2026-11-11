import { useConsoleRegistry } from './api/console'
import { useEffect, useRef, useState } from 'react'
import { ConsoleLayout, LayoutNavigationItem, LayoutNavigationGroup, LayoutNavigationSubItem, SidebarMenu, LayoutUserDropdown, Dialog, ResourcePage, useMutationSubmit } from '@workbasehq/ui'
import { Link, Outlet, useLocation, useNavigate, useMatches } from '@tanstack/react-router'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, logoutSession } from './api/client'
import { Skeleton } from '@workbasehq/ui/components/ui/skeleton'
import { fetchCapabilities, useBuild, useCapabilities, type Me } from './api/queries'
import { useSidebar } from '@workbasehq/ui/components/ui/sidebar'
import { DropdownMenuItem } from '@workbasehq/ui/components/ui/dropdown-menu'
import { useInvitationDestination } from './api/invitation-destination'
import { instanceOptions } from './api/identity'
import { bootstrapOptions, isBootstrappedRoute } from './api/bootstrap'
import { QueryError } from './screens'
import { OrganizationSwitcher } from './organization-switcher'
import { organizationDestination } from './api/organization-destination'
import { activeNavigationItem } from './navigation'
import { NavigationIconView } from './navigation-icons'
import { Database, Settings, Folder, Languages, Info } from 'lucide-react'
import { ProfileGate } from './profile'
import { profileOptions } from './api/profile'
import { applyInstanceLanguage } from './i18n'
import { useRuntimeModel } from './api/runtime-model'
import { RuntimeLocalization } from './runtime-localization'
import { RecordBreadcrumbProvider } from '../../console-generated/src/breadcrumbs'
import { Breadcrumbs } from './Breadcrumbs'
import { instanceTitle, useConsoleTitle } from './console-title'
import './styles.css'
export function Frame() {
  const location = useLocation(); const client = useQueryClient(); const { t } = useTranslation()
  const gated = isBootstrappedRoute(location.pathname)
  const schema = useQuery({ ...instanceOptions, enabled: !gated })
  useConsoleTitle(schema.data?.displayName, location.pathname)
  useEffect(() => { if (schema.data) applyInstanceLanguage(schema.data.ui?.defaultLanguage ?? schema.data.locale) }, [schema.data])
  const orgId = /^\/o\/([^/]+)/.exec(location.pathname)?.[1]
  useRuntimeModel(orgId ? decodeURIComponent(orgId) : undefined)
  useEffect(() => { client.removeQueries({ queryKey: ['resource-denied'], type: 'inactive' }) }, [client, location.pathname])
  useEffect(() => () => {
    if (!orgId) return
    const scope = decodeURIComponent(orgId)
    for (const key of ['console-model', 'bootstrap', 'capabilities', 'console-registry', 'workflow-schema']) client.removeQueries({ queryKey: [key, scope], exact: true })
  }, [client, orgId])
  // Profile and bootstrap are independent reads. Keep the completeness gate while
  // starting both in the first wave; bootstrap seeds safe metadata and scoped grants.
  const boot = useQuery({ ...bootstrapOptions(client, orgId ? decodeURIComponent(orgId) : undefined), enabled: gated })
  const content = gated && !boot.data ? <main id="main">{boot.error ? <QueryError error={boot.error} /> : <div role="status" aria-label={t('loading')} className="space-y-4 p-4"><Skeleton className="h-9 w-64" /><Skeleton className="h-24 w-full" /></div>}</main> : <RecordBreadcrumbProvider>{orgId ? <RuntimeLocalization key={orgId} orgId={decodeURIComponent(orgId)}><FrameContent /></RuntimeLocalization> : <FrameContent />}</RecordBreadcrumbProvider>
  return gated ? <ProfileGate>{content}</ProfileGate> : content
}
function FrameContent() {
  const { t, i18n } = useTranslation(); const location = useLocation(); const navigate = useNavigate(); const client = useQueryClient(); const matches = useMatches()
  const publicRoute = !['/', '/organizations'].includes(location.pathname) && !location.pathname.startsWith('/o/') && !location.pathname.startsWith('/settings')
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me', { redirect401: /^\/(o\/|organizations)/.test(location.pathname) }), enabled: !publicRoute, staleTime: Infinity })
  // ProfileGate already fetched this projection before mounting the frame.
  const profile = useQuery({ ...profileOptions, refetchOnMount: false, enabled: !publicRoute })
  const build = useBuild()
  const schema = useQuery({ ...instanceOptions, enabled: !publicRoute })
  const orgId = /^\/o\/([^/]+)/.exec(location.pathname)?.[1]
  const caps = useCapabilities(orgId)
  const registry = useConsoleRegistry(orgId)
  // The capability projection carries the same server gates as the read routes.
  // Do not fetch whole system collections just to decide sidebar visibility.
  const workflowDenied = useQuery({ queryKey: ['workflow-denied', orgId ?? ''], queryFn: () => false, initialData: false, enabled: false }).data
  const grants = caps.error ? {} : caps.data?.resources ?? {}
  const canReadWorkflows = !workflowDenied && grants['workflows.read']
  const accountNavigation = useRef(false); const aboutRequested = useRef(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [reloaded] = useState(() => { const value = sessionStorage.getItem('console-schema-reloaded'); sessionStorage.removeItem('console-schema-reloaded'); return !!value })
  const membership = me.data?.memberships.find(org => org.organization_id === orgId)
  const submit = useMutationSubmit()
  const logout = useMutation({ mutationFn: () => logoutSession(client) })
  useEffect(() => {
    let heading: HTMLElement | null = null
    const focus = () => { const next = document.querySelector<HTMLElement>('h1'); if (next && next !== heading) { heading = next; next.focus() } }
    focus(); const observer = new MutationObserver(focus); observer.observe(document.getElementById('main')!, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [location.pathname])
  const workspace = me.data?.organizationsEnabled === false ? <span className="px-2 py-3 font-medium">{instanceTitle(schema.data?.displayName)}</span> : <OrganizationSwitcher key={orgId} activeId={orgId} allowCreate={me.data?.organizationCreationAllowed !== false} memberships={me.data?.memberships ?? []} onSwitch={async id => { const next = await client.fetchQuery({ queryKey: ['capabilities', id], queryFn: () => fetchCapabilities(client, id), staleTime: 0 }); await navigate({ to: organizationDestination(location.pathname, id, next) }) }} />
  const currentView = (location.search as { view?: string }).view
  const items = registry.error ? [] : (registry.data?.navigation ?? []).filter(item => item.placement === 'sidebar')
  const activeItem = (item: typeof items[number]) => item.entity ? activeNavigationItem({ id: item.id, entity: item.entity, view: item.view }, location.pathname, orgId!, currentView, registry.data?.modelUi?.navigation) : location.pathname === `/o/${orgId}${registry.data?.pages.find(page => page.id === item.page)?.path}`
  const itemLink = (item: typeof items[number]) => {
    const page = registry.data?.pages.find(page => page.id === item.page)
    const target = '/o/' + orgId + (page?.path ?? '/e/' + item.entity)
    return <Link to={target} search={item.view ? { view: item.view } : {}}>{item.icon ? <NavigationIconView name={item.icon} /> : !item.group && <Database />}<span>{t(item.label, { defaultValue: item.label })}</span></Link>
  }
  const groups = [...new Map(items.filter(item => item.group).map(item => [item.group!.id, item.group!])).values()]
  const entries = [...items.filter(item => !item.group).map(item => ({ id: item.id, order: item.order, item })), ...groups.map(group => ({ id: group.id, order: group.order, group }))].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
  const navigation = orgId && <SidebarMenu>{entries.map(entry => {
    if ('item' in entry) return <LayoutNavigationItem key={entry.id} active={activeItem(entry.item)}>{itemLink(entry.item)}</LayoutNavigationItem>
    const group = entry.group; const children = items.filter(item => item.group?.id === group.id)
    return <LayoutNavigationGroup key={group.id} label={t(group.label, { defaultValue: group.label })} active={children.some(activeItem)} icon={group.icon ? <NavigationIconView name={group.icon} /> : <Folder />}>
      {children.map(item => <LayoutNavigationSubItem key={item.id} active={activeItem(item)}>{itemLink(item)}</LayoutNavigationSubItem>)}
    </LayoutNavigationGroup>
  })}</SidebarMenu>
  const breadcrumbs = <Breadcrumbs navigation={registry.data?.modelUi?.navigation} membershipName={membership?.name} canReadWorkflows={!!canReadWorkflows} />
  const account = <LayoutUserDropdown onCloseAutoFocus={event => { if (aboutRequested.current) { event.preventDefault(); aboutRequested.current = false; setAboutOpen(true); return }; if (accountNavigation.current) { event.preventDefault(); accountNavigation.current = false; document.querySelector<HTMLElement>('main h1')?.focus() } }} user={me.data?.user ? { ...me.data.user, name: profile.data?.displayName ?? me.data.user.name } : undefined} label={t('accountLabel')} signOutLabel={t('signOut')} pendingLabel={t('saving')} signOut={() => void submit(() => logout.mutateAsync())} pending={logout.isPending} build={build.data && <><p>{t('revision', { revision: build.data.revision })}</p><p>{t('built', { date: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(build.data.builtAt)) })}</p><code>{build.data.sha.slice(0, 8)}</code></>}>
    <AccountSettingsItem member={membership?.role === 'member'} orgId={orgId} onNavigate={() => { accountNavigation.current = true }} />
    <DropdownMenuItem aria-label={t('switchLanguage')} onSelect={() => { const language = i18n.language === 'cs' ? 'en' : 'cs'; void i18n.changeLanguage(language); document.documentElement.lang = language }}><Languages />{t('languageLabel')}</DropdownMenuItem>
    <DropdownMenuItem onSelect={() => { aboutRequested.current = true }}><Info />{t('about')}</DropdownMenuItem>
  </LayoutUserDropdown>
  if (location.pathname === '/invitation') return <main id="main"><Outlet /></main>
  if (location.pathname === '/organizations' && me.data?.memberships.length === 0) return <main id="main"><Outlet /></main>
  if (publicRoute) return <><header className="h-14 flex items-center border-b px-4 font-medium">{instanceTitle(schema.data?.displayName)}</header><main id="main" className="mx-auto max-w-xl p-4 pt-10"><Outlet /></main></>
  return <ConsoleLayout closeLabel={t('close')} skipLabel={t('skipContent')} title={breadcrumbs} routeKey={location.pathname} navigationTriggerLabel={t('openNavigation')} navigationLabel={t('navigation')} mobileNavigationLabel={t('mobileNavigation')} sidebarTitle={t('workspaceLabel')} workspace={workspace} account={account} navigation={navigation} noContentPadding={matches.some(match => match.staticData.noLayoutContentPadding)}>
    <Dialog open={aboutOpen} onOpenChange={setAboutOpen} title={t('about')} description={t('description')} closeLabel={t('close')} onCloseAutoFocus={event => { event.preventDefault(); document.querySelector<HTMLButtonElement>('[data-slot="account"] button')?.focus() }} />
    {logout.error && <p role="alert">{t('requestFailed')}</p>}
    {reloaded && <p role="status">{t('schemaReloaded')}</p>}<Outlet />
  </ConsoleLayout>
}
export function Overview() {
  const { t } = useTranslation(); const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me', { redirect401: false }) })
  const destination = useInvitationDestination(null, me.data?.memberships)
  useEffect(() => { if (me.data?.user && destination.target) window.location.replace(destination.target) }, [me.data, destination.target])
  const schema = useQuery({ ...instanceOptions, enabled: false })
  if (destination.error) return <QueryError error={destination.error} />
  return <ResourcePage title={t('title', { instanceTitle: instanceTitle(schema.data?.displayName) })}><div className="wb-empty"><h2>{t('welcome')}</h2><p>{t('empty')}</p><Link to="/organizations">{t('organizations')}</Link><p><Dialog trigger={t('about')} title={t('about')} description={t('description')} closeLabel={t('close')} /></p></div></ResourcePage>
}

function AccountSettingsItem({ orgId, onNavigate, member }: { member?: boolean; orgId?: string; onNavigate: () => void }) {
  const { t } = useTranslation(); const navigate = useNavigate(); const { setOpenMobile } = useSidebar()
  return <DropdownMenuItem onSelect={() => { onNavigate(); setOpenMobile(false); void navigate({ to: orgId ? '/o/$orgId/settings/profile' : '/settings/profile', params: orgId ? { orgId } : {} }) }}><Settings />{t(member ? 'profileSettings' : 'settings')}</DropdownMenuItem>
}
