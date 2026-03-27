import {
  Activity,
  Building2,
  FileText,
  Key,
  Layers,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Ticket,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useLocation } from 'react-router'
import { AppBreadcrumb } from '@/shared/components/app-breadcrumb'
import { ModeToggle } from '@/shared/components/mode-toggle'
import { Separator } from '@/shared/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from '@/shared/components/ui/sidebar'
import { UserMenu } from '@/shared/components/user-menu'
import { useAuthInit } from '@/shared/hooks/use-auth-init'

const monitoringItems = [
  { to: '/ui/admin', key: 'nav.sessions', icon: Activity, end: true },
  { to: '/ui/admin/log', key: 'nav.log', icon: FileText, end: false },
]

const configItems = [
  { to: '/ui/admin/config/targets', key: 'nav.targets', icon: Server },
  { to: '/ui/admin/config/target-groups', key: 'nav.groups', icon: Layers },
  { to: '/ui/admin/config/users', key: 'nav.users', icon: Users },
  { to: '/ui/admin/config/roles', key: 'nav.roles', icon: Shield },
]

const securityItems = [
  { to: '/ui/admin/config/ssh-keys', key: 'nav.sshKeys', icon: Key },
  { to: '/ui/admin/config/tickets', key: 'nav.tickets', icon: Ticket },
  { to: '/ui/admin/config/ldap', key: 'nav.ldap', icon: Building2 },
]

const systemItems = [
  { to: '/ui/admin/config/parameters', key: 'nav.parameters', icon: Settings2 },
]

function isNavActive(pathname: string, to: string, end: boolean): boolean {
  if (end)
    return pathname === to
  return pathname === to || pathname.startsWith(`${to}/`)
}

interface NavGroupProps {
  items: Array<{ to: string, key: string, icon: React.ElementType, end?: boolean }>
  pathname: string
  t: (key: string) => string
}

function NavGroup({ items, pathname, t }: NavGroupProps) {
  return (
    <SidebarMenu>
      {items.map(item => (
        <SidebarMenuItem key={item.to}>
          <SidebarMenuButton
            render={<Link to={item.to} />}
            isActive={isNavActive(pathname, item.to, item.end ?? false)}
            tooltip={t(item.key)}
          >
            <item.icon />
            <span>{t(item.key)}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}

export function AdminLayout() {
  const { t } = useTranslation(['admin', 'common'])
  const location = useLocation()

  useAuthInit()

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link to="/ui/admin" className="gap-3" />}>
                <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <ShieldCheck className="size-4" />
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold tracking-tight">Gated</span>
                  <span className="text-xs text-sidebar-foreground/60">{t('common:adminTitle')}</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{t('common:nav.monitoring')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <NavGroup items={monitoringItems} pathname={location.pathname} t={key => t(key)} />
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          <SidebarGroup>
            <SidebarGroupLabel>{t('common:nav.configuration')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <NavGroup items={configItems} pathname={location.pathname} t={key => t(key)} />
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          <SidebarGroup>
            <SidebarGroupLabel>{t('common:nav.security')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <NavGroup items={securityItems} pathname={location.pathname} t={key => t(key)} />
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          <SidebarGroup>
            <SidebarGroupLabel>{t('common:nav.system')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <NavGroup items={systemItems} pathname={location.pathname} t={key => t(key)} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <UserMenu variant="sidebar" />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <AppBreadcrumb />
          <div className="ml-auto">
            <ModeToggle />
          </div>
        </header>
        <main className="flex-1 p-4 overflow-auto">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
