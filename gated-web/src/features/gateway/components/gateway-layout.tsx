import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { ChevronsUpDown, Key, LogOut, Server, User } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/shared/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { Button } from '@/shared/components/ui/button'
import { ModeToggle } from '@/shared/components/mode-toggle'
import { AppBreadcrumb } from '@/shared/components/app-breadcrumb'
import { useAuthStore } from '@/shared/stores/auth'
import { useInfoQuery, useLogoutMutation } from '@/features/gateway/api'

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-1.5 text-sm px-2 py-1 rounded transition-colors ${
    isActive
      ? 'text-foreground font-medium'
      : 'text-muted-foreground hover:text-foreground'
  }`

export function GatewayLayout() {
  const { t } = useTranslation(['gateway', 'common'])
  const navigate = useNavigate()
  const { setAuth, clearAuth, isAuthenticated, username } = useAuthStore()

  const infoQuery = useInfoQuery()
  const logoutMutation = useLogoutMutation()

  useEffect(() => {
    if (infoQuery.isSuccess) {
      const info = infoQuery.data
      if (info.username) {
        setAuth(info.username, false)
      } else {
        clearAuth()
      }
    } else if (infoQuery.isError) {
      clearAuth()
    }
  }, [infoQuery.isSuccess, infoQuery.isError, infoQuery.data, setAuth, clearAuth])

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        clearAuth()
        void navigate('/@gated/login')
      },
      onError: () => {
        toast.error(t('gateway:nav.logoutError'))
      },
    })
  }

  const userInitials = username ? username.slice(0, 2).toUpperCase() : 'U'

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="border-b border-border px-6 h-14 flex items-center gap-4">
        <Link to="/@gated" className="text-lg font-heading font-semibold shrink-0 mr-2">
          {t('common:appName')}
        </Link>

        {isAuthenticated && (
          <nav className="flex items-center gap-1">
            <NavLink to="/@gated" end className={navLinkClass}>
              <Server className="size-4" />
              <span>{t('gateway:nav.targets')}</span>
            </NavLink>
          </nav>
        )}

        <div className="ml-auto flex items-center gap-2">
          <ModeToggle />
          {isAuthenticated ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2 h-9 px-2">
                  <Avatar className="size-7">
                    <AvatarFallback className="text-xs">{userInitials}</AvatarFallback>
                  </Avatar>
                  <span className="text-sm hidden sm:inline">{username}</span>
                  <ChevronsUpDown className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem asChild>
                  <Link to="/@gated/profile">
                    <User className="mr-2 size-4" />
                    {t('gateway:nav.profile')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/@gated/profile/api-tokens">
                    <Key className="mr-2 size-4" />
                    {t('gateway:pages.apiTokens')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} disabled={logoutMutation.isPending}>
                  <LogOut className="mr-2 size-4" />
                  {t('gateway:nav.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>

      {isAuthenticated && (
        <div className="border-b border-border px-6 h-9 flex items-center">
          <AppBreadcrumb />
        </div>
      )}

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
