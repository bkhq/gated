import { Link, Outlet, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  Building2,
  ChevronsUpDown,
  FileText,
  Key,
  Layers,
  LogOut,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Ticket,
  User,
  Users,
} from 'lucide-react'
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
import { Separator } from '@/shared/components/ui/separator'
import { Avatar, AvatarFallback } from '@/shared/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { ModeToggle } from '@/shared/components/mode-toggle'
import { AppBreadcrumb } from '@/shared/components/app-breadcrumb'
import { useAuthStore } from '@/shared/stores/auth'

const monitorItems = [
  { to: '/@gated/admin', key: 'nav.sessions', icon: Activity, end: true },
  { to: '/@gated/admin/log', key: 'nav.log', icon: FileText, end: false },
]

const configItems = [
  { to: '/@gated/admin/config/targets', key: 'nav.targets', icon: Server },
  { to: '/@gated/admin/config/users', key: 'nav.users', icon: Users },
  { to: '/@gated/admin/config/roles', key: 'nav.roles', icon: Shield },
  { to: '/@gated/admin/config/tickets', key: 'nav.tickets', icon: Ticket },
  { to: '/@gated/admin/config/ssh-keys', key: 'nav.sshKeys', icon: Key },
  { to: '/@gated/admin/config/ldap', key: 'nav.ldap', icon: Building2 },
  { to: '/@gated/admin/config/target-groups', key: 'nav.groups', icon: Layers },
  { to: '/@gated/admin/config/parameters', key: 'nav.parameters', icon: Settings2 },
]

function isNavActive(pathname: string, to: string, end: boolean): boolean {
  if (end) return pathname === to
  return pathname === to || pathname.startsWith(to + '/')
}

export function AdminLayout() {
  const { t } = useTranslation(['admin', 'common'])
  const location = useLocation()
  const { username } = useAuthStore()

  const userInitials = username
    ? username.slice(0, 2).toUpperCase()
    : 'AD'

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link to="/@gated/admin">
                  <ShieldCheck className="size-5 shrink-0" />
                  <span className="font-heading font-semibold">{t('common:adminTitle')}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{t('common:nav.monitoring')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {monitorItems.map(item => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={isNavActive(location.pathname, item.to, item.end)}
                      tooltip={t(item.key)}
                    >
                      <Link to={item.to}>
                        <item.icon />
                        <span>{t(item.key)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          <SidebarGroup>
            <SidebarGroupLabel>{t('common:nav.configuration')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {configItems.map(item => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={isNavActive(location.pathname, item.to, false)}
                      tooltip={t(item.key)}
                    >
                      <Link to={item.to}>
                        <item.icon />
                        <span>{t(item.key)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  >
                    <Avatar className="size-8 rounded-lg">
                      <AvatarFallback className="rounded-lg text-xs">{userInitials}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 text-left text-sm leading-tight truncate">
                      <span className="font-medium">{username ?? 'Admin'}</span>
                    </div>
                    <ChevronsUpDown className="ml-auto size-4 shrink-0" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-56">
                  <DropdownMenuItem asChild>
                    <Link to="/@gated/profile">
                      <User className="mr-2 size-4" />
                      {t('common:user.profile')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/@gated/login">
                      <LogOut className="mr-2 size-4" />
                      {t('common:user.logout')}
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <AppBreadcrumb />
          <div className="ml-auto">
            <ModeToggle />
          </div>
        </header>
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
