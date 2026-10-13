import { useQueryClient } from '@tanstack/react-query'
import { Navigate, Outlet, useMatchRoute, useRouter } from '@tanstack/react-router'
import * as React from 'react'
import { SessionsPage } from '@/features/session/sessions-page'
import { GatedLogo } from '@/shared/components/gated-logo'
import { useInfo } from '@/shared/hooks/use-info'
import { useSiteTitle } from '@/shared/hooks/use-site-title'
import { setOnUnauthorized } from '@/shared/lib/api/http'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/shared/ui/sidebar'
import { useAppStore } from '@/store/app-store'
import { AppSidebar } from './sidebar'
import { SpotlightDialog } from './spotlight-dialog'

const SIDEBAR_STYLE = {
  '--sidebar-width': '248px',
  '--sidebar-width-icon': '64px',
} as React.CSSProperties

// Module-scoped sentinel — Vite's HMR re-runs init code and can remount the
// shell, which would otherwise let the unmount cleanup land AFTER the new
// effect's setOnUnauthorized() call and clear the callback to null. Guarding
// here means we register exactly once per page load (last-write-wins inside
// http.ts handles re-binding if router/queryClient identities ever change).
let unauthorizedRegistered = false

export function AppLayout() {
  const info = useInfo()
  const siteTitle = useSiteTitle()
  const username = info.isError ? null : info.data?.username ?? null
  const admin = info.data?.admin ?? false
  const matchRoute = useMatchRoute()
  const isLoginRoute = matchRoute({ to: '/auth/login' })
  const isSessionsRoute = Boolean(matchRoute({ to: '/sessions' }))
  const hasTerminalTabs = useAppStore(state => state.terminalTabs.length > 0)
  const identityUsername = useAppStore(state => state.identity.username)
  const updateIdentity = useAppStore(state => state.updateIdentity)
  const fullscreen = useAppStore(state => state.terminalFullscreen)
  const collapsed = useAppStore(state => state.sidebarCollapsed)
  const setCollapsed = useAppStore(state => state.setSidebarCollapsed)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const router = useRouter()
  const queryClient = useQueryClient()

  // A configured site title replaces the static <title> from index.html.
  const configuredTitle = info.data?.site_title?.trim()
  React.useEffect(() => {
    if (!configuredTitle)
      return undefined
    const previous = document.title
    document.title = configuredTitle
    return () => {
      document.title = previous
    }
  }, [configuredTitle])

  React.useEffect(() => {
    updateIdentity({
      name: username ?? '',
      username: username ?? '',
      email: '',
      role: username ? (admin ? 'Admin' : 'User') : '',
    })
  }, [username, admin, updateIdentity])

  React.useEffect(() => {
    if (unauthorizedRegistered)
      return
    unauthorizedRegistered = true
    setOnUnauthorized(() => {
      // Fire-and-forget the server-side logout: cookie may already be invalid
      // (that's why we got the 401), but it never hurts to ask. We don't await
      // because we want the redirect to happen instantly.
      void useAppStore.getState().signOut().catch(() => {})
      queryClient.removeQueries()
      void router.navigate({ to: '/auth/login' })
    })
  }, [router, queryClient])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (isLoginRoute) {
    return <Outlet />
  }

  if (info.isPending)
    return null

  if (!username) {
    const next = window.location.pathname + window.location.search + window.location.hash
    return <Navigate to="/auth/login" search={{ next }} replace />
  }

  if (identityUsername !== username)
    return null

  return (
    <SidebarProvider
      open={!collapsed}
      onOpenChange={open => setCollapsed(!open)}
      style={SIDEBAR_STYLE}
      className="min-h-screen"
    >
      {fullscreen ? null : <AppSidebar onSearch={() => setSearchOpen(true)} />}
      <SidebarInset className="min-w-0 bg-background">
        {fullscreen
          ? null
          : (
              <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background px-3 md:hidden">
                <SidebarTrigger />
                <GatedLogo title={siteTitle} />
              </div>
            )}
        <Outlet />
        {isSessionsRoute || hasTerminalTabs ? <SessionsPage visible={isSessionsRoute} /> : null}
      </SidebarInset>
      <SpotlightDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </SidebarProvider>
  )
}
