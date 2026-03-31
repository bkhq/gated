import { ChevronRight, Key, Server, ShieldCheck, Terminal, User } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useLocation } from 'react-router'
import { useTargetsQuery } from '@/features/gateway/api'
import { LanguageToggle } from '@/shared/components/language-toggle'
import { ModeToggle } from '@/shared/components/mode-toggle'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/components/ui/collapsible'
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
} from '@/shared/components/ui/sidebar'
import { UserMenu } from '@/shared/components/user-menu'
import { useAuthInit } from '@/shared/hooks/use-auth-init'

function SshTargetsGroup() {
  const { t } = useTranslation('gateway')
  const { data: targets = [] } = useTargetsQuery()

  const sshTargets = targets.filter(tgt => tgt.kind === 'Ssh')

  return (
    <Collapsible defaultOpen className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger
          render={(
            <SidebarMenuButton tooltip="SSH" />
          )}
        >
          <Terminal className="size-4" />
          <span>SSH</span>
          <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sshTargets.map(target => (
              <SidebarMenuSubItem key={target.name}>
                <SidebarMenuSubButton
                  render={<Link to={`/ui/ssh/${encodeURIComponent(target.name)}`} target="_blank" />}
                >
                  <Server className="size-3" />
                  <span>{target.name}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
            {sshTargets.length === 0 && (
              <SidebarMenuSubItem>
                <span className="px-2 py-1 text-xs text-muted-foreground">{t('targetList.empty')}</span>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

function isNavActive(pathname: string, to: string, end: boolean): boolean {
  if (end)
    return pathname === to
  return pathname === to || pathname.startsWith(`${to}/`)
}

const accountItems = [
  { to: '/ui/profile', key: 'gateway:nav.profile', icon: User, end: true },
  { to: '/ui/profile/api-tokens', key: 'gateway:pages.apiTokens', icon: Key, end: false },
]

export function GatewayLayout() {
  const { t } = useTranslation(['gateway', 'common'])
  const location = useLocation()

  useAuthInit()

  return (
    <SidebarProvider>
      <Sidebar collapsible="none">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link to="/ui" className="gap-3" />}>
                <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <ShieldCheck className="size-4" />
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold tracking-tight">{t('common:appName')}</span>
                  <span className="text-xs text-sidebar-foreground/60">Gateway</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{t('gateway:nav.targets')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link to="/ui" />}
                    isActive={location.pathname === '/ui'}
                    tooltip={t('gateway:nav.targets')}
                  >
                    <Server />
                    <span>{t('gateway:nav.allTargets')}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>{t('gateway:nav.terminals')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SshTargetsGroup />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          <SidebarGroup>
            <SidebarGroupLabel>{t('gateway:nav.profile')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {accountItems.map(item => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      render={<Link to={item.to} />}
                      isActive={isNavActive(location.pathname, item.to, item.end)}
                      tooltip={t(item.key)}
                    >
                      <item.icon />
                      <span>{t(item.key)}</span>
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
              <UserMenu variant="sidebar" />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4">
          <h1 className="text-sm font-medium">{t('common:appName')}</h1>
          <div className="ml-auto flex items-center gap-1">
            <LanguageToggle />
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
