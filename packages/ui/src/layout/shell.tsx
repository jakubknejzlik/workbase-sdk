import { useEffect, useRef, type ReactNode } from 'react'
import { Layout, LayoutBase, LayoutHeader } from '../vendor/tiketo/components/layout/Layout'
import { useSidebar } from '../components/ui/sidebar'

export interface LayoutProps {
  title: ReactNode; navigationLabel: string; navigation: ReactNode; workspace?: ReactNode; account?: ReactNode; skipLabel?: string; navigationTriggerLabel?: string; mobileNavigationLabel?: string; sidebarTitle?: string; routeKey?: string; children: ReactNode; closeLabel?: string; noContentPadding?: boolean
}
function ShellBody(props: LayoutProps) {
  const { setOpenMobile, openMobile, isMobile } = useSidebar()
  const navigationTrigger = useRef<HTMLButtonElement>(null)
  const closedByNavigation = useRef(false)
  useEffect(() => { if (openMobile) closedByNavigation.current = false }, [openMobile])
  useEffect(() => { closedByNavigation.current = true; setOpenMobile(false) }, [props.routeKey, setOpenMobile])
  return <>
    <a className="wb-skip" href="#main">{props.skipLabel}</a>
    <Layout noContentPadding={props.noContentPadding} sidebar={{
      props: { title: props.sidebarTitle ?? props.navigationLabel, description: props.navigationLabel, closeLabel: props.closeLabel, onCloseAutoFocus: event => {
        event.preventDefault()
        if (closedByNavigation.current) document.querySelector<HTMLElement>('main h1')?.focus()
        else navigationTrigger.current?.focus()
      } },
      header: props.workspace,
      content: <nav aria-label={isMobile ? props.mobileNavigationLabel ?? props.navigationLabel : props.navigationLabel}>{props.navigation}</nav>,
      footer: props.account,
    }} header={<LayoutHeader triggerRef={navigationTrigger} triggerLabel={props.navigationTriggerLabel} breadcrumbs={props.title} />}>
      {props.children}
    </Layout>
  </>
}
export function ConsoleLayout(props: LayoutProps) { return <LayoutBase><ShellBody {...props} /></LayoutBase> }
