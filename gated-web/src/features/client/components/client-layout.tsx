import { ArrowLeft, Monitor, PanelLeftClose, PanelLeftOpen, Plus, Server, Terminal, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useTargetsQuery } from '@/features/gateway/api'
import { Button } from '@/shared/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/shared/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from '@/shared/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/shared/components/ui/tooltip'
import { useAuthInit } from '@/shared/hooks/use-auth-init'
import { TerminalPanel } from '../pages/terminal-panel'

interface TerminalTab {
  id: string
  targetName: string
}

let tabCounter = 0

function SidebarToggle() {
  const { toggleSidebar, open } = useSidebar()
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" className="size-7" onClick={toggleSidebar} />}>
        {open ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
      </TooltipTrigger>
      <TooltipContent side="bottom">Toggle sidebar</TooltipContent>
    </Tooltip>
  )
}

export function ClientLayout() {
  const { t } = useTranslation(['gateway', 'common'])
  const { data: targets = [] } = useTargetsQuery()
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)

  useAuthInit()

  const sshTargets = targets.filter(tgt => tgt.kind === 'Ssh')

  // Click sidebar item: focus existing tab or create new
  const openOrFocusTerminal = useCallback((targetName: string) => {
    const existing = tabs.find(t => t.targetName === targetName)
    if (existing != null) {
      setActiveTabId(existing.id)
      return
    }
    tabCounter++
    const id = `tab-${tabCounter}`
    setTabs(prev => [...prev, { id, targetName }])
    setActiveTabId(id)
  }, [tabs])

  // Force open a new tab (even if one exists for this target)
  const forceNewTab = useCallback((targetName: string) => {
    tabCounter++
    const id = `tab-${tabCounter}`
    setTabs(prev => [...prev, { id, targetName }])
    setActiveTabId(id)
  }, [])

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const next = prev.filter(t => t.id !== tabId)
      if (activeTabId === tabId) {
        setActiveTabId(next.length > 0 ? next.at(-1)!.id : null)
      }
      return next
    })
  }, [activeTabId])

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon" className="border-r border-border">
          <SidebarHeader className="h-10 flex-row items-center px-3 border-b border-border gap-2">
            <Monitor className="size-4 text-sidebar-primary shrink-0" />
            <span className="text-sm font-semibold truncate group-data-[collapsible=icon]:hidden">{t('common:appName')}</span>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {sshTargets.map((target) => {
                    const hasTab = tabs.some(t => t.targetName === target.name)
                    const isActive = tabs.some(t => t.targetName === target.name && t.id === activeTabId)
                    return (
                      <ContextMenu key={target.name}>
                        <SidebarMenuItem>
                          <ContextMenuTrigger
                            render={(
                              <SidebarMenuButton
                                className="cursor-pointer"
                                onClick={() => openOrFocusTerminal(target.name)}
                                isActive={isActive}
                                tooltip={target.name}
                              />
                            )}
                          >
                            <Server className="size-4 shrink-0" />
                            <span className="truncate">{target.name}</span>
                            {hasTab && <span className="ml-auto size-1.5 rounded-full bg-emerald-500 shrink-0 group-data-[collapsible=icon]:hidden" />}
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem onClick={() => openOrFocusTerminal(target.name)}>
                              <Terminal className="size-4 mr-2" />
                              {t('gateway:client.connect')}
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => forceNewTab(target.name)}>
                              <Plus className="size-4 mr-2" />
                              {t('gateway:client.newConnection')}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </SidebarMenuItem>
                      </ContextMenu>
                    )
                  })}
                  {sshTargets.length === 0 && (
                    <SidebarMenuItem>
                      <span className="px-3 py-2 text-xs text-muted-foreground">{t('gateway:targetList.empty')}</span>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="border-t border-border">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/ui" />} tooltip={t('gateway:client.backToHome')}>
                  <ArrowLeft className="size-4" />
                  <span>{t('gateway:client.backToHome')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="flex flex-col h-screen overflow-hidden">
          {/* Tab bar */}
          <div className="flex items-center h-10 shrink-0 border-b border-border bg-muted/30">
            <SidebarToggle />
            <div className="flex items-center flex-1 overflow-x-auto">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  className={`flex items-center gap-1.5 h-10 px-3 text-sm border-r border-border shrink-0 transition-colors cursor-pointer ${
                    tab.id === activeTabId
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground hover:bg-background/50'
                  }`}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  <Terminal className="size-3 shrink-0" />
                  <span className="max-w-32 truncate">{tab.targetName}</span>
                  <button
                    type="button"
                    className="ml-0.5 p-0.5 rounded hover:bg-muted-foreground/20 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(tab.id)
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </button>
              ))}
            </div>
            {/* New tab: dropdown to pick target */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon" className="size-10 shrink-0" />}
                    >
                      <Plus className="size-3.5" />
                    </DropdownMenuTrigger>
                  )}
                >
                  <Plus className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('gateway:client.newTab')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                {sshTargets.map(target => (
                  <DropdownMenuItem key={target.name} onClick={() => forceNewTab(target.name)}>
                    <Server className="size-4 mr-2" />
                    {target.name}
                  </DropdownMenuItem>
                ))}
                {sshTargets.length === 0 && (
                  <DropdownMenuItem disabled>
                    {t('gateway:targetList.empty')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Terminal panels */}
          <div className="flex-1 relative bg-[#1a1a1a] overflow-hidden">
            {tabs.length === 0 && (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center space-y-3">
                  <Terminal className="size-12 mx-auto opacity-20" />
                  <p className="text-sm font-medium">{t('gateway:client.noTabs')}</p>
                  <p className="text-xs text-muted-foreground/60">{t('gateway:client.selectServer')}</p>
                </div>
              </div>
            )}
            {tabs.map(tab => (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
              >
                <TerminalPanel targetName={tab.targetName} tabId={tab.id} isActive={tab.id === activeTabId} />
              </div>
            ))}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
