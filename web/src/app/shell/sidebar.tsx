import type { LucideIcon } from 'lucide-react'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  Activity,
  ChevronUp,
  FileText,
  Gavel,
  HardDrive,
  Home,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  ShieldBan,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Ticket,
  User,
  Users,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthRequests } from '@/features/auth-requests/hooks/use-auth-requests-queries'
import { useMyLiveSessions } from '@/features/sessions/hooks/use-sessions-queries'
import { GatedLogo } from '@/shared/components/gated-logo'
import { useIsAdmin } from '@/shared/hooks/use-info'
import { useSiteTitle } from '@/shared/hooks/use-site-title'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/shared/ui/sidebar'
import { useAppStore } from '@/store/app-store'
import { UserMenu } from './user-menu'

interface NavItem {
  to: string
  labelKey: string
  icon: LucideIcon
  badge?: 'sessions' | 'pending'
}

interface NavGroup {
  labelKey: string
  items: NavItem[]
}

const USER_NAV: NavItem[] = [
  { to: '/overview', labelKey: 'nav.overview', icon: Home },
  { to: '/targets', labelKey: 'nav.targets', icon: Server },
  { to: '/auth-requests', labelKey: 'nav.authRequests', icon: Inbox, badge: 'pending' },
  { to: '/sessions', labelKey: 'nav.sessions', icon: Terminal, badge: 'sessions' },
]

const ADMIN_GROUPS: NavGroup[] = [
  {
    labelKey: 'section.adminResources',
    items: [
      { to: '/admin/targets', labelKey: 'nav.adminTargets', icon: Server },
      { to: '/admin/accounts', labelKey: 'nav.adminAccounts', icon: User },
    ],
  },
  {
    labelKey: 'section.adminIam',
    items: [
      { to: '/admin/users', labelKey: 'nav.adminUsers', icon: Users },
      { to: '/admin/roles', labelKey: 'nav.adminRoles', icon: ShieldCheck },
      { to: '/admin/tickets', labelKey: 'nav.adminTickets', icon: Ticket },
    ],
  },
  {
    labelKey: 'section.adminCommandControl',
    items: [
      { to: '/admin/command-acl', labelKey: 'nav.adminCommandAcl', icon: ShieldBan },
      { to: '/admin/command-reviews', labelKey: 'nav.adminCommandReviews', icon: Gavel },
    ],
  },
  {
    labelKey: 'section.adminMonitoring',
    items: [
      { to: '/admin/sessions', labelKey: 'nav.adminSessions', icon: Activity },
      { to: '/admin/audit', labelKey: 'nav.adminAudit', icon: FileText },
    ],
  },
  {
    labelKey: 'section.adminSystem',
    items: [
      { to: '/admin/known-hosts', labelKey: 'nav.adminKnownHosts', icon: HardDrive },
      { to: '/admin/params', labelKey: 'nav.adminParams', icon: SlidersHorizontal },
    ],
  },
]

function BrandHeader() {
  const { t } = useTranslation()
  const { state, toggleSidebar } = useSidebar()
  const collapsed = state === 'collapsed'
  const siteTitle = useSiteTitle()
  const [hover, setHover] = React.useState(false)
  const expandLabel = t('a11y.shell.expandSidebar')
  const collapseLabel = t('a11y.shell.collapseSidebar')

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggleSidebar}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="focus-ring inline-flex size-8 items-center justify-center rounded-md text-foreground transition-colors duration-100 ease-out hover:bg-sidebar-accent"
        title={expandLabel}
        aria-label={expandLabel}
        aria-expanded={false}
        aria-controls="app-primary-nav"
      >
        {hover ? <PanelLeftOpen className="size-4" /> : <GatedLogo compact />}
      </button>
    )
  }

  return (
    <div className="flex w-full items-center justify-between gap-2">
      <GatedLogo title={siteTitle} />
      <button
        type="button"
        onClick={toggleSidebar}
        className="focus-ring inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 ease-out hover:bg-sidebar-accent hover:text-foreground"
        title={collapseLabel}
        aria-label={collapseLabel}
        aria-expanded={true}
        aria-controls="app-primary-nav"
      >
        <PanelLeftClose className="size-3.5" />
      </button>
    </div>
  )
}

function NavItemRow({
  item,
  active,
  badgeCount,
}: {
  item: NavItem
  active: boolean
  badgeCount: number | null
}) {
  const { t } = useTranslation()
  const { state } = useSidebar()
  const collapsed = state === 'collapsed'
  const Icon = item.icon
  const label = t(item.labelKey)
  const badgeSrText = badgeCount ? ` (${t('a11y.shell.navBadgeCount', { count: badgeCount })})` : ''
  const tooltipText = badgeCount ? `${label}${badgeSrText}` : label

  const content = (
    <>
      <Icon aria-hidden="true" className={cn('opacity-85', active && 'opacity-100')} />
      {collapsed && <span className="sr-only">{`${label}${badgeSrText}`}</span>}
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && badgeCount
        ? (
            <Badge tone="info" className="ml-auto h-[18px] px-1.5 py-0" aria-hidden="true">
              {badgeCount}
            </Badge>
          )
        : null}
    </>
  )

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={tooltipText}
        className="h-8"
        aria-current={active ? 'page' : undefined}
        render={<Link to={item.to} />}
      >
        {content}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function UserMenuFooter({ pendingCount }: { pendingCount: number }) {
  const { state } = useSidebar()
  const collapsed = state === 'collapsed'
  const { t } = useTranslation()
  const identity = useAppStore(s => s.identity)

  const btnRef = React.useRef<HTMLButtonElement>(null)
  const [open, setOpen] = React.useState(false)

  const userMenuLabel = t('a11y.shell.userMenu')
  const pendingSr = pendingCount ? ` (${t('a11y.shell.navBadgeCount', { count: pendingCount })})` : ''

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            ref={btnRef}
            size="lg"
            tooltip={`${identity.name} · ${identity.email}${pendingSr}`}
            isActive={open}
            onClick={() => setOpen(v => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls="app-user-menu"
            aria-label={`${userMenuLabel}: ${identity.name}${pendingSr}`}
            className={cn(
              'relative h-auto gap-2.5 px-2 py-1.5',
              'group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:p-0!',
            )}
          >
            <Avatar name={identity.name} size={collapsed ? 32 : 30} />
            <div className="flex min-w-0 flex-1 flex-col text-left group-data-[collapsible=icon]:hidden">
              <span className="truncate text-[13px] font-medium text-foreground">{identity.name}</span>
              <span className="truncate text-[11px] font-normal text-muted-foreground">{identity.username}</span>
            </div>
            <ChevronUp aria-hidden="true" className="ml-auto size-3.5 text-muted-foreground/70 group-data-[collapsible=icon]:hidden" />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      <UserMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={btnRef}
        collapsed={collapsed}
        pendingCount={pendingCount}
      />
    </>
  )
}

export function AppSidebar() {
  const { t } = useTranslation()
  const isAdmin = useIsAdmin()
  const pathname = useRouterState({ select: s => s.location.pathname })
  const authRequests = useAuthRequests().data ?? []
  const sessions = useMyLiveSessions().data ?? []
  const pendingCount = authRequests.filter(r => r.state === 'pending').length
  const sessionCount = sessions.length

  const badgeOf = (item: NavItem): number | null => {
    if (item.badge === 'pending')
      return pendingCount || null
    if (item.badge === 'sessions')
      return sessionCount || null
    return null
  }
  const isActive = (item: NavItem) =>
    pathname === item.to || pathname.startsWith(`${item.to}/`)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-10 flex-row items-center justify-between gap-0 border-b border-sidebar-border py-0 pl-4 pr-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
        <BrandHeader />
      </SidebarHeader>

      <SidebarContent
        id="app-primary-nav"
        role="navigation"
        aria-label={t('a11y.shell.primaryNav')}
        className="gap-0 px-2 pt-2 pb-4 group-data-[collapsible=icon]:px-1.5"
      >
        <SidebarGroup className="px-0 py-0">
          <SidebarGroupLabel>{t('section.workspace')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {USER_NAV.map(item => (
                <NavItemRow
                  key={item.to}
                  item={item}
                  active={isActive(item)}
                  badgeCount={badgeOf(item)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {isAdmin && (
          <>
            {ADMIN_GROUPS.map((group, gi) => (
              <SidebarGroup
                key={group.labelKey}
                className={cn('px-0 py-0', gi > 0 && 'mt-1')}
              >
                <SidebarGroupLabel className="pt-1.5 pb-0.5 text-[10.5px] tracking-wide opacity-85">
                  {t(group.labelKey)}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map(item => (
                      <NavItemRow
                        key={item.to}
                        item={item}
                        active={isActive(item)}
                        badgeCount={badgeOf(item)}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2.5 group-data-[collapsible=icon]:p-2">
        <UserMenuFooter pendingCount={pendingCount} />
      </SidebarFooter>
    </Sidebar>
  )
}
